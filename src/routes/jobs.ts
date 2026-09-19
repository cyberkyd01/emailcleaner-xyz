import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { sleep } from '../lib/retry.js';
import { describeQuery, formatBytes, parseCleanQuery } from '../providers/query.js';
import { DEFAULT_CLEANABLE_ROLES } from '../providers/types.js';
import { getAccountProtections, getFolders, openProvider } from '../services/accounts.js';
import { planClean } from '../services/engine.js';
import {
  cancelJob,
  confirmJob,
  createJob,
  getJob,
  getJobItems,
  listJobs,
  requestUndo,
} from '../services/jobs.js';
import { currentUser, requireUser } from './plugin.js';

const createJobSchema = z.object({
  accountId: z.string().min(1),
  query: z.unknown(),
  mode: z.enum(['trash', 'permanent']).default('trash'),
});

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Explains what a query would do without touching the mailbox: which folders
   * it resolves to, what runs server-side vs locally, and what is risky.
   * Cheap enough to call on every keystroke in the rule editor.
   */
  app.post('/api/jobs/explain', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const body = request.body as { accountId?: string; query?: unknown };
    if (!body?.accountId) throw badRequest('accountId is required');

    const query = parseCleanQuery(body.query);

    const provider = await openProvider(user.id, body.accountId);
    try {
      const protections = await getAccountProtections(user.id, body.accountId);
      const plan = await planClean(provider, query, protections);
      return {
        description: describeQuery(query, plan.folders),
        folders: plan.folders.map((f) => ({
          remoteId: f.remoteId,
          path: f.path,
          role: f.role,
          messageCount: f.messageCount,
        })),
        notes: plan.notes,
        warnings: plan.warnings,
        unmatchedSelectors: plan.unmatchedSelectors,
        requiresBodyFetch: plan.requiresBody,
        capabilities: provider.capabilities,
      };
    } finally {
      await provider.close();
    }
  });

  /** Queues a job. It previews first and waits for confirmation — nothing is deleted yet. */
  app.post('/api/jobs', { preHandler: requireUser }, async (request, reply) => {
    const parsed = createJobSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('accountId and query are required');
    const job = await createJob({
      userId: currentUser(request).id,
      accountId: parsed.data.accountId,
      query: parsed.data.query,
      mode: parsed.data.mode,
      origin: 'api',
    });
    reply.code(202);
    return { job, next: `Poll GET /api/jobs/${job.id} until status is "awaiting_confirm", then POST /api/jobs/${job.id}/confirm.` };
  });

  /**
   * One-call convenience for the common "clean these sections" ask: builds the
   * query from folder roles so callers do not have to.
   */
  app.post('/api/jobs/clean-sections', { preHandler: requireUser }, async (request, reply) => {
    const body = request.body as {
      accountId?: string;
      sections?: string[];
      olderThanDays?: number;
      mode?: 'trash' | 'permanent';
    };
    if (!body?.accountId) throw badRequest('accountId is required');

    const sections = body.sections?.length ? body.sections : [...DEFAULT_CLEANABLE_ROLES];
    const job = await createJob({
      userId: currentUser(request).id,
      accountId: body.accountId,
      query: {
        folders: sections,
        olderThanDays: body.olderThanDays,
        excludeStarred: true,
        excludeImportant: true,
      },
      mode: body.mode ?? 'trash',
      origin: 'api',
    });
    reply.code(202);
    return { job };
  });

  /** One-call convenience for the keyword ask. */
  app.post('/api/jobs/clean-keyword', { preHandler: requireUser }, async (request, reply) => {
    const body = request.body as {
      accountId?: string;
      keyword?: string;
      keywords?: string[];
      scope?: 'anywhere' | 'subject' | 'from' | 'subject_or_from';
      sections?: string[];
      mode?: 'trash' | 'permanent';
    };
    if (!body?.accountId) throw badRequest('accountId is required');
    const keywords = body.keywords ?? (body.keyword ? [body.keyword] : []);
    if (keywords.length === 0) throw badRequest('Provide keyword or keywords');

    const job = await createJob({
      userId: currentUser(request).id,
      accountId: body.accountId,
      query: {
        // No folder list means every folder except the protected ones, which is
        // what "find this keyword everywhere" should mean.
        folders: body.sections ?? [],
        keywords,
        keywordMatch: 'any',
        keywordScope: body.scope ?? 'anywhere',
        excludeStarred: true,
        excludeImportant: true,
      },
      mode: body.mode ?? 'trash',
      origin: 'api',
    });
    reply.code(202);
    return { job };
  });

  app.get('/api/jobs', { preHandler: requireUser }, async (request) => {
    const q = request.query as { accountId?: string; limit?: string };
    return {
      jobs: await listJobs(currentUser(request).id, {
        accountId: q.accountId,
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    };
  });

  app.get('/api/jobs/:id', { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    const job = await getJob(currentUser(request).id, id);
    return {
      job,
      humanSize: job.stats.bytes ? formatBytes(job.stats.bytes) : null,
    };
  });

  app.get('/api/jobs/:id/items', { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    const q = request.query as { limit?: string; offset?: string; state?: string };
    return {
      items: await getJobItems(currentUser(request).id, id, {
        limit: q.limit ? Number(q.limit) : undefined,
        offset: q.offset ? Number(q.offset) : undefined,
        state: q.state,
      }),
    };
  });

  /** Live progress without polling. Closes when the job reaches a terminal state. */
  app.get('/api/jobs/:id/events', { preHandler: requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = currentUser(request).id;

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const terminal = new Set(['completed', 'failed', 'cancelled', 'undone', 'awaiting_confirm']);
    let closed = false;
    request.raw.on('close', () => {
      closed = true;
    });

    try {
      for (let tick = 0; !closed && tick < 3600; tick++) {
        const job = await getJob(userId, id);
        reply.raw.write(`data: ${JSON.stringify(job)}\n\n`);
        if (terminal.has(job.status)) break;
        await sleep(1500);
      }
    } catch (err) {
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`);
    } finally {
      reply.raw.end();
    }
    return reply;
  });

  app.post('/api/jobs/:id/confirm', { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { acknowledgeLargeDelete?: boolean } | undefined;
    return { job: await confirmJob(currentUser(request).id, id, { acknowledgeLargeDelete: body?.acknowledgeLargeDelete }) };
  });

  app.post('/api/jobs/:id/cancel', { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    return { job: await cancelJob(currentUser(request).id, id) };
  });

  app.post('/api/jobs/:id/undo', { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    return { job: await requestUndo(currentUser(request).id, id) };
  });

  /** Folder roles this account actually has, for building "clean sections" UIs. */
  app.get('/api/accounts/:id/sections', { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    const folders = await getFolders(currentUser(request).id, id);
    const roles = new Map<string, { role: string; folders: string[]; messages: number; cleanableByDefault: boolean }>();
    for (const folder of folders) {
      const entry = roles.get(folder.role) ?? {
        role: folder.role,
        folders: [],
        messages: 0,
        cleanableByDefault: (DEFAULT_CLEANABLE_ROLES as readonly string[]).includes(folder.role),
      };
      entry.folders.push(folder.path);
      entry.messages += folder.messageCount ?? 0;
      roles.set(folder.role, entry);
    }
    return { sections: [...roles.values()] };
  });
}
