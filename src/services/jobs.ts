import { getDb, isoIn, nowIso } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { logger } from '../lib/logger.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { config } from '../config.js';
import { describeQuery, parseCleanQuery } from '../providers/query.js';
import { getAccountProtections, getAccountRow, openProvider } from './accounts.js';
import { assertCanStartJob, jobMessageCeiling, undoWindowDaysFor } from './plans.js';
import { deleteRefs, planClean, streamMatches, type CleanPlan } from './engine.js';
import { audit } from './audit.js';
import type { DeleteMode, JobStatus, JobTable } from '../db/types.js';
import type { CleanQuery, MessageRef } from '../providers/types.js';

const SAMPLE_SIZE = 25;

export interface JobStats {
  scanned?: number;
  bytes?: number;
  byFolder?: Array<{ remoteId: string; path: string; role: string; matched: number; bytes: number }>;
  notes?: string[];
  warnings?: string[];
  description?: string;
  /** Progress heartbeat so a long preview is not a black box. */
  progress?: { phase: string; scanned: number; matched: number; deleted?: number; at: string };
}

export interface JobView {
  id: string;
  accountId: string;
  ruleId: string | null;
  status: JobStatus;
  mode: DeleteMode;
  origin: string;
  query: CleanQuery;
  stats: JobStats;
  matched: number;
  deleted: number;
  failed: number;
  truncated: boolean;
  error: string | null;
  undoExpiresAt: string | null;
  createdAt: string;
  startedAt: string | null;
  confirmedAt: string | null;
  finishedAt: string | null;
}

export const toJobView = (row: JobTable): JobView => ({
  id: row.id,
  accountId: row.account_id,
  ruleId: row.rule_id,
  status: row.status,
  mode: row.mode,
  origin: row.origin,
  query: JSON.parse(row.query_json) as CleanQuery,
  stats: JSON.parse(row.stats_json) as JobStats,
  matched: row.matched_count,
  deleted: row.deleted_count,
  failed: row.failed_count,
  truncated: row.truncated === 1,
  error: row.error,
  undoExpiresAt: row.undo_expires_at,
  createdAt: row.created_at,
  startedAt: row.started_at,
  confirmedAt: row.confirmed_at,
  finishedAt: row.finished_at,
});

// ---------------------------------------------------------------------------
// Creation & retrieval
// ---------------------------------------------------------------------------

export interface CreateJobInput {
  userId: string;
  accountId: string;
  query: unknown;
  mode?: DeleteMode;
  ruleId?: string | null;
  origin?: 'manual' | 'schedule' | 'api';
  /** Skip the confirmation step. Refused for permanent deletes. */
  autoConfirm?: boolean;
}

export async function createJob(input: CreateJobInput): Promise<JobView> {
  const query = parseCleanQuery(input.query);
  const mode: DeleteMode = input.mode ?? 'trash';

  if (mode === 'permanent' && input.autoConfirm && input.origin !== 'schedule') {
    throw badRequest(
      'Permanent deletion cannot be auto-confirmed from an ad-hoc request. Review the preview and confirm it explicitly.',
    );
  }

  // Fail with a clear 404 before touching the jobs table, rather than letting
  // a foreign-key violation surface as an internal error.
  await getAccountRow(input.userId, input.accountId);
  // Scheduled runs are not charged against the monthly allowance twice; the
  // rule was already checked when it was saved.
  if (input.origin !== 'schedule') await assertCanStartJob(input.userId);

  const db = await getDb();
  const id = newId('job');
  const now = nowIso();

  await db
    .insertInto('jobs')
    .values({
      id,
      user_id: input.userId,
      account_id: input.accountId,
      rule_id: input.ruleId ?? null,
      status: 'queued',
      mode,
      origin: input.origin ?? 'manual',
      query_json: JSON.stringify(query),
      stats_json: JSON.stringify({
        description: describeQuery(query),
        autoConfirm: input.autoConfirm === true,
      } satisfies JobStats & { autoConfirm: boolean }),
      matched_count: 0,
      deleted_count: 0,
      failed_count: 0,
      truncated: 0,
      error: null,
      attempts: 0,
      locked_by: null,
      locked_until: null,
      undo_expires_at: null,
      created_at: now,
      updated_at: now,
      started_at: null,
      confirmed_at: null,
      finished_at: null,
    })
    .execute();

  await audit({
    userId: input.userId,
    accountId: input.accountId,
    jobId: id,
    action: 'job.created',
    detail: { mode, origin: input.origin ?? 'manual', query: describeQuery(query) },
  });

  return getJob(input.userId, id);
}

export async function getJob(userId: string, jobId: string): Promise<JobView> {
  const db = await getDb();
  const row = await db
    .selectFrom('jobs')
    .selectAll()
    .where('id', '=', jobId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row) throw notFound('Job');
  return toJobView(row);
}

export async function listJobs(userId: string, opts: { accountId?: string; limit?: number } = {}): Promise<JobView[]> {
  const db = await getDb();
  let q = db.selectFrom('jobs').selectAll().where('user_id', '=', userId);
  if (opts.accountId) q = q.where('account_id', '=', opts.accountId);
  const rows = await q.orderBy('created_at', 'desc').limit(Math.min(opts.limit ?? 50, 200)).execute();
  return rows.map(toJobView);
}

export interface JobItemView {
  remoteId: string;
  folder: string | null;
  subject: string | null;
  from: string | null;
  sentAt: string | null;
  sizeBytes: number | null;
  state: string;
  error: string | null;
}

export async function getJobItems(
  userId: string,
  jobId: string,
  opts: { limit?: number; offset?: number; state?: string } = {},
): Promise<JobItemView[]> {
  await getJob(userId, jobId);
  const db = await getDb();
  let q = db.selectFrom('job_items').selectAll().where('job_id', '=', jobId);
  if (opts.state) q = q.where('state', '=', opts.state as never);
  const rows = await q
    .orderBy('id')
    .limit(Math.min(opts.limit ?? 100, 1000))
    .offset(opts.offset ?? 0)
    .execute();

  return rows.map((r) => ({
    remoteId: r.remote_id,
    folder: r.folder_remote_id,
    subject: r.subject,
    from: r.from_addr,
    sentAt: r.sent_at,
    sizeBytes: r.size_bytes,
    state: r.state,
    error: r.error,
  }));
}

// ---------------------------------------------------------------------------
// User transitions
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  /** Required when the match count exceeds MAX_DELETE_PER_JOB. */
  acknowledgeLargeDelete?: boolean;
}

export async function confirmJob(userId: string, jobId: string, opts: ConfirmOptions = {}): Promise<JobView> {
  const job = await getJob(userId, jobId);
  if (job.status !== 'awaiting_confirm') {
    throw conflict(`Job is ${job.status}; only a previewed job awaiting confirmation can be confirmed.`);
  }
  if (job.matched === 0) {
    throw conflict('The preview matched nothing, so there is nothing to confirm.');
  }
  if (job.matched > config.limits.maxDeletePerJob && !opts.acknowledgeLargeDelete) {
    throw conflict(
      `This would delete ${job.matched.toLocaleString()} messages, above the ${config.limits.maxDeletePerJob.toLocaleString()} safety limit. Re-send with acknowledgeLargeDelete:true if that is intended.`,
      { matched: job.matched, limit: config.limits.maxDeletePerJob },
    );
  }

  const db = await getDb();
  const now = nowIso();
  await db
    .updateTable('jobs')
    .set({ status: 'queued_execute', confirmed_at: now, updated_at: now, locked_by: null, locked_until: null })
    .where('id', '=', jobId)
    .where('status', '=', 'awaiting_confirm')
    .execute();

  await audit({
    userId,
    accountId: job.accountId,
    jobId,
    action: 'job.confirmed',
    detail: { matched: job.matched, mode: job.mode, acknowledgedLarge: opts.acknowledgeLargeDelete === true },
  });

  return getJob(userId, jobId);
}

export async function cancelJob(userId: string, jobId: string): Promise<JobView> {
  const job = await getJob(userId, jobId);
  const cancellable: JobStatus[] = ['queued', 'previewing', 'awaiting_confirm', 'queued_execute'];
  if (!cancellable.includes(job.status)) {
    throw conflict(`Job is ${job.status} and can no longer be cancelled.`);
  }
  const db = await getDb();
  const now = nowIso();
  await db
    .updateTable('jobs')
    .set({ status: 'cancelled', finished_at: now, updated_at: now, locked_by: null, locked_until: null })
    .where('id', '=', jobId)
    .execute();
  await audit({ userId, accountId: job.accountId, jobId, action: 'job.cancelled' });
  return getJob(userId, jobId);
}

export async function requestUndo(userId: string, jobId: string): Promise<JobView> {
  const job = await getJob(userId, jobId);
  if (job.status !== 'completed') throw conflict(`Job is ${job.status}; only a completed job can be undone.`);
  if (job.mode === 'permanent') {
    throw conflict('This job deleted messages permanently. There is nothing to restore.');
  }
  if (job.undoExpiresAt && new Date(job.undoExpiresAt) < new Date()) {
    throw conflict('The undo window for this job has closed.');
  }

  const db = await getDb();
  const now = nowIso();
  await db
    .updateTable('jobs')
    .set({ status: 'undoing', updated_at: now, locked_by: null, locked_until: null })
    .where('id', '=', jobId)
    .where('status', '=', 'completed')
    .execute();
  await audit({ userId, accountId: job.accountId, jobId, action: 'job.undo_requested', detail: { deleted: job.deleted } });
  return getJob(userId, jobId);
}

// ---------------------------------------------------------------------------
// Worker-side execution
// ---------------------------------------------------------------------------

const CLAIMABLE: JobStatus[] = ['queued', 'queued_execute', 'undoing'];
const LEASE_MS = 5 * 60_000;

/**
 * Leases one job to a worker. The lease is what lets a second worker take over
 * after a crash without two workers ever deleting the same mail.
 */
export async function claimJob(workerId: string): Promise<JobTable | null> {
  const db = await getDb();
  const now = nowIso();

  const candidate = await db
    .selectFrom('jobs')
    .selectAll()
    .where('status', 'in', CLAIMABLE)
    .where((eb) => eb.or([eb('locked_until', 'is', null), eb('locked_until', '<', now)]))
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();
  if (!candidate) return null;

  // Conditional update on the lease we just read — whoever wins updates 1 row.
  const result = await db
    .updateTable('jobs')
    .set({ locked_by: workerId, locked_until: isoIn(LEASE_MS), updated_at: now })
    .where('id', '=', candidate.id)
    .where('status', '=', candidate.status)
    .where((eb) =>
      candidate.locked_until === null
        ? eb('locked_until', 'is', null)
        : eb('locked_until', '=', candidate.locked_until),
    )
    .executeTakeFirst();

  if (Number(result.numUpdatedRows ?? 0) === 0) return null;
  return { ...candidate, locked_by: workerId };
}

async function patchJob(jobId: string, patch: Partial<JobTable>): Promise<void> {
  const db = await getDb();
  await db
    .updateTable('jobs')
    .set({ ...patch, updated_at: nowIso() } as never)
    .where('id', '=', jobId)
    .execute();
}

async function heartbeat(jobId: string, stats: JobStats): Promise<void> {
  await patchJob(jobId, {
    stats_json: JSON.stringify(stats),
    locked_until: isoIn(LEASE_MS),
  });
}

/** Dispatches a leased job to the right phase. */
export async function runJob(job: JobTable, signal?: AbortSignal): Promise<void> {
  const log = logger.child({ jobId: job.id, accountId: job.account_id, status: job.status });
  try {
    if (job.status === 'queued') await runPreview(job, signal);
    else if (job.status === 'queued_execute') await runExecute(job, signal);
    else if (job.status === 'undoing') await runUndo(job, signal);
  } catch (err) {
    const message = (err as Error).message;
    log.error('job failed', { error: message });
    await patchJob(job.id, {
      status: 'failed',
      error: message,
      finished_at: nowIso(),
      locked_by: null,
      locked_until: null,
      attempts: job.attempts + 1,
    });
    await audit({
      userId: job.user_id,
      accountId: job.account_id,
      jobId: job.id,
      action: 'job.failed',
      detail: { phase: job.status, error: message },
    });
  }
}

async function loadPlan(job: JobTable): Promise<{ plan: CleanPlan; provider: Awaited<ReturnType<typeof openProvider>> }> {
  const query = JSON.parse(job.query_json) as CleanQuery;
  const protections = await getAccountProtections(job.user_id, job.account_id);
  const provider = await openProvider(job.user_id, job.account_id);
  const plan = await planClean(provider, query, protections);
  return { plan, provider };
}

async function runPreview(job: JobTable, signal?: AbortSignal): Promise<void> {
  await patchJob(job.id, { status: 'previewing', started_at: job.started_at ?? nowIso() });
  const stats = JSON.parse(job.stats_json) as JobStats & { autoConfirm?: boolean };
  const { plan, provider } = await loadPlan(job);

  try {
    const query = JSON.parse(job.query_json) as CleanQuery;
    const planCap = await jobMessageCeiling(job.user_id, config.limits.maxTrackedItems);
    const cap = Math.min(query.limit ?? planCap, planCap);
    await clearJobItems(job.id);

    // One pass over the mailbox: count, tally per folder, keep a display sample,
    // and record every id so execution replays exactly what the user approved
    // rather than re-searching a mailbox that has moved on since.
    const tallies = new Map<string, { remoteId: string; path: string; role: string; matched: number; bytes: number }>();
    for (const folder of plan.folders) {
      tallies.set(folder.remoteId, { remoteId: folder.remoteId, path: folder.path, role: folder.role, matched: 0, bytes: 0 });
    }

    const matches: MessageRef[] = [];
    const sample: MessageRef[] = [];
    let scanned = 0;
    let matchedCount = 0;
    let bytes = 0;
    let lastBeat = 0;

    for await (const batch of streamMatches(provider, plan, {
      signal,
      limit: cap,
      hydrateAtLeast: SAMPLE_SIZE,
      onProgress: (seen, hit) => {
        const now = Date.now();
        if (now - lastBeat < 2000) return;
        lastBeat = now;
        void heartbeat(job.id, {
          ...stats,
          progress: { phase: 'previewing', scanned: seen, matched: hit, at: nowIso() },
        });
      },
    })) {
      scanned = batch.scanned;
      matchedCount = batch.matched;
      for (const ref of batch.refs) {
        matches.push(ref);
        bytes += ref.sizeBytes ?? 0;
        const tally = tallies.get(ref.folderRemoteId ?? '');
        if (tally) {
          tally.matched++;
          tally.bytes += ref.sizeBytes ?? 0;
        }
        if (sample.length < SAMPLE_SIZE) sample.push(ref);
      }
      // Flush ids in chunks so a huge preview does not sit entirely in memory.
      if (matches.length >= 5000) {
        await appendJobItems(job.id, matches.splice(0, matches.length));
      }
    }

    const result = {
      matched: matchedCount,
      scanned,
      bytes,
      byFolder: [...tallies.values()].filter((t) => t.matched > 0).sort((a, b) => b.matched - a.matched),
      sample,
      truncated: matchedCount >= cap,
    };

    await appendJobItems(job.id, matches);

    await patchJob(job.id, {
      status: 'awaiting_confirm',
      matched_count: result.matched,
      truncated: result.truncated ? 1 : 0,
      stats_json: JSON.stringify({
        ...stats,
        scanned: result.scanned,
        bytes: result.bytes,
        byFolder: result.byFolder,
        notes: plan.notes,
        warnings: plan.warnings,
        sample: result.sample.slice(0, SAMPLE_SIZE).map((r) => ({
          subject: r.subject,
          from: r.from,
          sentAt: r.sentAt,
          sizeBytes: r.sizeBytes,
          folder: r.folderRemoteId,
        })),
        progress: { phase: 'previewed', scanned: result.scanned, matched: result.matched, at: nowIso() },
      }),
      locked_by: null,
      locked_until: null,
    });

    await audit({
      userId: job.user_id,
      accountId: job.account_id,
      jobId: job.id,
      action: 'job.previewed',
      detail: { matched: result.matched, scanned: result.scanned, truncated: result.truncated },
    });

    // Scheduled rules that opted in skip the manual gate — but only for
    // reversible trash deletes, and only below the safety limit.
    if (
      stats.autoConfirm === true &&
      result.matched > 0 &&
      job.mode === 'trash' &&
      result.matched <= config.limits.maxDeletePerJob
    ) {
      await patchJob(job.id, { status: 'queued_execute', confirmed_at: nowIso() });
    }
  } finally {
    await provider.close();
  }
}

/** Wipes any ids left over from a previous preview attempt. */
async function clearJobItems(jobId: string): Promise<void> {
  const db = await getDb();
  await db.deleteFrom('job_items').where('job_id', '=', jobId).execute();
}

async function appendJobItems(jobId: string, refs: MessageRef[]): Promise<void> {
  if (refs.length === 0) return;
  const db = await getDb();
  const now = nowIso();

  // SQLite caps bound parameters per statement, so insert in modest chunks.
  for (let i = 0; i < refs.length; i += 250) {
    await db
      .insertInto('job_items')
      .values(
        refs.slice(i, i + 250).map((r) => ({
          job_id: jobId,
          remote_id: r.id,
          folder_remote_id: r.folderRemoteId,
          origin_folder_id: r.folderRemoteId,
          subject: r.subject ?? null,
          from_addr: r.from ?? null,
          sent_at: r.sentAt ?? null,
          size_bytes: r.sizeBytes ?? null,
          state: 'matched' as const,
          error: null,
          created_at: now,
        })),
      )
      .execute();
  }
}

async function runExecute(job: JobTable, signal?: AbortSignal): Promise<void> {
  await patchJob(job.id, { status: 'running', started_at: job.started_at ?? nowIso() });
  const stats = JSON.parse(job.stats_json) as JobStats;
  const db = await getDb();
  const provider = await openProvider(job.user_id, job.account_id);

  let deleted = 0;
  let failed = 0;

  try {
    for (;;) {
      if (signal?.aborted) throw new Error('Worker shutting down');

      const rows = await db
        .selectFrom('job_items')
        .selectAll()
        .where('job_id', '=', job.id)
        .where('state', '=', 'matched')
        .orderBy('id')
        .limit(500)
        .execute();
      if (rows.length === 0) break;

      const refs: MessageRef[] = rows.map((r) => ({
        id: r.remote_id,
        folderRemoteId: r.folder_remote_id,
        subject: r.subject,
        from: r.from_addr,
        sentAt: r.sent_at,
        sizeBytes: r.size_bytes,
      }));

      const outcome = await deleteRefs(provider, refs, job.mode);
      deleted += outcome.succeeded.length;
      failed += outcome.failed.length;

      if (outcome.succeeded.length > 0) {
        await db
          .updateTable('job_items')
          .set({ state: 'deleted' })
          .where('job_id', '=', job.id)
          .where('remote_id', 'in', outcome.succeeded)
          .execute();
      }
      for (const failure of outcome.failed) {
        await db
          .updateTable('job_items')
          .set({ state: 'failed', error: failure.error.slice(0, 500) })
          .where('job_id', '=', job.id)
          .where('remote_id', '=', failure.id)
          .execute();
      }

      await heartbeat(job.id, {
        ...stats,
        progress: { phase: 'deleting', scanned: stats.scanned ?? 0, matched: job.matched_count, deleted, at: nowIso() },
      });
      await patchJob(job.id, { deleted_count: deleted, failed_count: failed });
    }

    const undoDays = await undoWindowDaysFor(job.user_id, config.limits.undoWindowDays);
    const undoExpiry = job.mode === 'trash' ? isoIn(undoDays * 86_400_000) : null;
    await patchJob(job.id, {
      status: 'completed',
      deleted_count: deleted,
      failed_count: failed,
      finished_at: nowIso(),
      undo_expires_at: undoExpiry,
      locked_by: null,
      locked_until: null,
      stats_json: JSON.stringify({
        ...stats,
        progress: { phase: 'completed', scanned: stats.scanned ?? 0, matched: job.matched_count, deleted, at: nowIso() },
      }),
    });

    await audit({
      userId: job.user_id,
      accountId: job.account_id,
      jobId: job.id,
      action: 'job.completed',
      detail: { deleted, failed, mode: job.mode },
    });
  } finally {
    await provider.close();
  }
}

async function runUndo(job: JobTable, signal?: AbortSignal): Promise<void> {
  const db = await getDb();
  const provider = await openProvider(job.user_id, job.account_id);
  let restored = 0;
  let failed = 0;

  try {
    for (;;) {
      if (signal?.aborted) throw new Error('Worker shutting down');
      const rows = await db
        .selectFrom('job_items')
        .selectAll()
        .where('job_id', '=', job.id)
        .where('state', '=', 'deleted')
        .orderBy('id')
        .limit(500)
        .execute();
      if (rows.length === 0) break;

      const refs: MessageRef[] = rows.map((r) => ({
        id: r.remote_id,
        folderRemoteId: r.origin_folder_id ?? r.folder_remote_id,
        subject: r.subject,
      }));

      const outcome = await provider.restore(refs);
      restored += outcome.succeeded.length;
      failed += outcome.failed.length;

      if (outcome.succeeded.length > 0) {
        await db
          .updateTable('job_items')
          .set({ state: 'restored' })
          .where('job_id', '=', job.id)
          .where('remote_id', 'in', outcome.succeeded)
          .execute();
      }
      for (const failure of outcome.failed) {
        await db
          .updateTable('job_items')
          .set({ state: 'failed', error: failure.error.slice(0, 500) })
          .where('job_id', '=', job.id)
          .where('remote_id', '=', failure.id)
          .execute();
      }
      await heartbeat(job.id, { ...(JSON.parse(job.stats_json) as JobStats) });
    }

    await patchJob(job.id, {
      status: 'undone',
      finished_at: nowIso(),
      locked_by: null,
      locked_until: null,
    });
    await audit({
      userId: job.user_id,
      accountId: job.account_id,
      jobId: job.id,
      action: 'job.undone',
      detail: { restored, failed },
    });
  } finally {
    await provider.close();
  }
}
