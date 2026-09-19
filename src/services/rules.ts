import parser from 'cron-parser';
import { getDb, nowIso } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { describeQuery, parseCleanQuery } from '../providers/query.js';
import { createJob } from './jobs.js';
import { assertCanAddRule } from './plans.js';
import { audit } from './audit.js';
import type { CleanQuery, DeleteMode } from '../providers/types.js';
import type { RuleTable } from '../db/types.js';

export interface RuleView {
  id: string;
  accountId: string;
  name: string;
  query: CleanQuery;
  description: string;
  mode: DeleteMode;
  enabled: boolean;
  scheduleCron: string | null;
  autoConfirm: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

const toRuleView = (row: RuleTable): RuleView => {
  const query = JSON.parse(row.query_json) as CleanQuery;
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    query,
    description: describeQuery(query),
    mode: row.mode,
    enabled: row.enabled === 1,
    scheduleCron: row.schedule_cron,
    autoConfirm: row.auto_confirm === 1,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
  };
};

/** Cron is interpreted in UTC so a rule behaves the same wherever it runs. */
function nextRun(cron: string, after = new Date()): string {
  try {
    return parser.parseExpression(cron, { currentDate: after, tz: 'UTC' }).next().toISOString();
  } catch (err) {
    throw badRequest(`"${cron}" is not a valid 5-field cron expression: ${(err as Error).message}`);
  }
}

export interface UpsertRuleInput {
  userId: string;
  accountId: string;
  name: string;
  query: unknown;
  mode?: DeleteMode;
  enabled?: boolean;
  scheduleCron?: string | null;
  autoConfirm?: boolean;
}

export async function createRule(input: UpsertRuleInput): Promise<RuleView> {
  const query = parseCleanQuery(input.query);
  const mode: DeleteMode = input.mode ?? 'trash';

  // An unattended permanent delete has no recovery path at all. Scheduled rules
  // may only move mail to Trash.
  if (mode === 'permanent' && input.scheduleCron) {
    throw badRequest(
      'A scheduled rule cannot delete permanently. Schedule it as "trash" and empty the trash separately if you need that.',
    );
  }

  await assertCanAddRule(input.userId, Boolean(input.scheduleCron));

  const db = await getDb();
  const id = newId('rule');
  const now = nowIso();

  await db
    .insertInto('rules')
    .values({
      id,
      user_id: input.userId,
      account_id: input.accountId,
      name: input.name.trim() || 'Untitled rule',
      query_json: JSON.stringify(query),
      mode,
      enabled: input.enabled === false ? 0 : 1,
      schedule_cron: input.scheduleCron ?? null,
      auto_confirm: input.autoConfirm === true ? 1 : 0,
      last_run_at: null,
      next_run_at: input.scheduleCron ? nextRun(input.scheduleCron) : null,
      created_at: now,
      updated_at: now,
    })
    .execute();

  await audit({
    userId: input.userId,
    accountId: input.accountId,
    action: 'rule.created',
    detail: { ruleId: id, name: input.name, cron: input.scheduleCron, mode },
  });
  return getRule(input.userId, id);
}

export async function getRule(userId: string, ruleId: string): Promise<RuleView> {
  const db = await getDb();
  const row = await db
    .selectFrom('rules')
    .selectAll()
    .where('id', '=', ruleId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row) throw notFound('Rule');
  return toRuleView(row);
}

export async function listRules(userId: string, accountId?: string): Promise<RuleView[]> {
  const db = await getDb();
  let q = db.selectFrom('rules').selectAll().where('user_id', '=', userId);
  if (accountId) q = q.where('account_id', '=', accountId);
  return (await q.orderBy('created_at', 'desc').execute()).map(toRuleView);
}

export async function updateRule(
  userId: string,
  ruleId: string,
  patch: Partial<Pick<UpsertRuleInput, 'name' | 'query' | 'mode' | 'enabled' | 'scheduleCron' | 'autoConfirm'>>,
): Promise<RuleView> {
  const existing = await getRule(userId, ruleId);
  const db = await getDb();

  const cron = patch.scheduleCron === undefined ? existing.scheduleCron : patch.scheduleCron;
  const mode = patch.mode ?? existing.mode;
  if (mode === 'permanent' && cron) {
    throw badRequest('A scheduled rule cannot delete permanently.');
  }

  await db
    .updateTable('rules')
    .set({
      name: patch.name ?? existing.name,
      query_json: patch.query ? JSON.stringify(parseCleanQuery(patch.query)) : JSON.stringify(existing.query),
      mode,
      enabled: patch.enabled === undefined ? (existing.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
      schedule_cron: cron,
      auto_confirm: patch.autoConfirm === undefined ? (existing.autoConfirm ? 1 : 0) : patch.autoConfirm ? 1 : 0,
      next_run_at: cron ? nextRun(cron) : null,
      updated_at: nowIso(),
    })
    .where('id', '=', ruleId)
    .execute();

  await audit({ userId, accountId: existing.accountId, action: 'rule.updated', detail: { ruleId } });
  return getRule(userId, ruleId);
}

export async function deleteRule(userId: string, ruleId: string): Promise<void> {
  const existing = await getRule(userId, ruleId);
  const db = await getDb();
  await db.deleteFrom('rules').where('id', '=', ruleId).where('user_id', '=', userId).execute();
  await audit({ userId, accountId: existing.accountId, action: 'rule.deleted', detail: { ruleId } });
}

/** Queues a job from a rule right now, independent of its schedule. */
export async function runRuleNow(userId: string, ruleId: string): Promise<string> {
  const rule = await getRule(userId, ruleId);
  const job = await createJob({
    userId,
    accountId: rule.accountId,
    query: rule.query,
    mode: rule.mode,
    ruleId: rule.id,
    origin: 'manual',
  });
  return job.id;
}

/**
 * Called once a minute by the worker. Advancing next_run_at before queuing
 * means a slow job cannot cause the same rule to fire twice.
 */
export async function runDueRules(now = new Date()): Promise<number> {
  const db = await getDb();
  const due = await db
    .selectFrom('rules')
    .selectAll()
    .where('enabled', '=', 1)
    .where('next_run_at', 'is not', null)
    .where('next_run_at', '<=', now.toISOString())
    .limit(50)
    .execute();

  let queued = 0;
  for (const row of due) {
    const advanced = await db
      .updateTable('rules')
      .set({
        last_run_at: now.toISOString(),
        next_run_at: row.schedule_cron ? nextRun(row.schedule_cron, now) : null,
        updated_at: nowIso(),
      })
      .where('id', '=', row.id)
      .where('next_run_at', '=', row.next_run_at)
      .executeTakeFirst();
    if (Number(advanced.numUpdatedRows ?? 0) === 0) continue;

    try {
      await createJob({
        userId: row.user_id,
        accountId: row.account_id,
        query: JSON.parse(row.query_json),
        mode: row.mode,
        ruleId: row.id,
        origin: 'schedule',
        autoConfirm: row.auto_confirm === 1,
      });
      queued++;
    } catch (err) {
      logger.error('scheduled rule failed to queue', { ruleId: row.id, error: (err as Error).message });
    }
  }
  return queued;
}
