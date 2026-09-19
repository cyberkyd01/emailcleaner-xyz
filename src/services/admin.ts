import { getDb, nowIso, sql } from '../db/index.js';
import { forbidden, notFound } from '../lib/errors.js';
import { audit } from './audit.js';
import { currentUsage, getPlan } from './plans.js';
import type { PlanId, UserStatus } from '../db/types.js';

/**
 * Read models for the operator dashboard. Everything here is aggregate or
 * account-level metadata — subjects, senders and message bodies are never
 * surfaced to an administrator, because an admin has no business reading
 * someone else's mail.
 */

const num = (v: unknown): number => Number(v ?? 0);

/**
 * Values embedded in the count helper below are all server-generated ISO
 * timestamps and fixed enum strings, never user input, but they are escaped
 * anyway so the helper can never become an injection point.
 */
const lit = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * Per-user footprint on the server, computed from the actual stored bytes
 * rather than a row count, so the number means something. `length()` is
 * available on both SQLite and Postgres.
 */
const STORAGE_SQL = `
  SELECT
    u.id AS user_id,
    COALESCE(a.bytes, 0) + COALESCE(j.bytes, 0) + COALESCE(i.bytes, 0) + COALESCE(r.bytes, 0) AS bytes,
    COALESCE(i.items, 0) AS tracked_items
  FROM users u
  LEFT JOIN (
    SELECT user_id,
           SUM(LENGTH(secret_enc) + LENGTH(settings_json) + LENGTH(protections_json) + LENGTH(email)) AS bytes
    FROM accounts GROUP BY user_id
  ) a ON a.user_id = u.id
  LEFT JOIN (
    SELECT user_id, SUM(LENGTH(query_json) + LENGTH(stats_json)) AS bytes
    FROM jobs GROUP BY user_id
  ) j ON j.user_id = u.id
  LEFT JOIN (
    SELECT jb.user_id,
           SUM(LENGTH(ji.remote_id) + COALESCE(LENGTH(ji.subject), 0) + COALESCE(LENGTH(ji.from_addr), 0) + 64) AS bytes,
           COUNT(*) AS items
    FROM job_items ji JOIN jobs jb ON jb.id = ji.job_id GROUP BY jb.user_id
  ) i ON i.user_id = u.id
  LEFT JOIN (
    SELECT user_id, SUM(LENGTH(query_json) + LENGTH(name)) AS bytes
    FROM rules GROUP BY user_id
  ) r ON r.user_id = u.id
`;

export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  status: UserStatus;
  plan: PlanId;
  planName: string;
  twoFactorEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  lastSeenAt: string | null;
  loginCount: number;
  mailboxes: number;
  rules: number;
  jobsTotal: number;
  jobsLast30Days: number;
  messagesDeleted: number;
  /** Estimated bytes this user occupies in the application database. */
  storageBytes: number;
  trackedItems: number;
  /** 'active' within 7 days, 'idle' within 30, else 'dormant'. Null if never seen. */
  activity: 'active' | 'idle' | 'dormant' | 'never';
  quota: {
    mailboxes: { used: number; limit: number };
    jobsPerMonth: { used: number; limit: number | null };
    rules: { used: number; limit: number };
  };
}

function activityOf(lastSeen: string | null): AdminUserRow['activity'] {
  if (!lastSeen) return 'never';
  const age = Date.now() - new Date(lastSeen).getTime();
  if (age <= 7 * 86_400_000) return 'active';
  if (age <= 30 * 86_400_000) return 'idle';
  return 'dormant';
}

export interface ListUsersOptions {
  search?: string | undefined;
  plan?: string | undefined;
  status?: string | undefined;
  sort?: string | undefined;
  limit?: number;
  offset?: number;
}

export async function listUsers(opts: ListUsersOptions = {}): Promise<{ users: AdminUserRow[]; total: number }> {
  const db = await getDb();
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();

  let query = db.selectFrom('users').selectAll();
  if (opts.search) {
    const needle = `%${opts.search.toLowerCase()}%`;
    query = query.where((eb) =>
      eb.or([eb(sql`lower(email)`, 'like', needle), eb(sql`lower(coalesce(display_name, ''))`, 'like', needle)]),
    );
  }
  if (opts.plan) query = query.where('plan', '=', opts.plan as PlanId);
  if (opts.status) query = query.where('status', '=', opts.status as UserStatus);

  const totalRow = await query.clearSelect().select((eb) => eb.fn.countAll().as('c')).executeTakeFirst();
  const total = num(totalRow?.c);

  const rows = await query
    .orderBy('created_at', 'desc')
    .limit(Math.min(opts.limit ?? 50, 500))
    .offset(opts.offset ?? 0)
    .execute();
  if (rows.length === 0) return { users: [], total };

  const ids = rows.map((r) => r.id);

  const [storage, jobStats, counts] = await Promise.all([
    sql
      .raw<{ user_id: string; bytes: number; tracked_items: number }>(STORAGE_SQL)
      .execute(db)
      .then((r) => new Map(r.rows.map((x) => [x.user_id, x]))),
    db
      .selectFrom('jobs')
      .select((eb) => [
        'user_id',
        eb.fn.countAll().as('jobs_total'),
        eb.fn.sum('deleted_count').as('deleted'),
      ])
      .where('user_id', 'in', ids)
      .groupBy('user_id')
      .execute()
      .then((r) => new Map(r.map((x) => [x.user_id, x]))),
    db
      .selectFrom('jobs')
      .select((eb) => ['user_id', eb.fn.countAll().as('recent')])
      .where('user_id', 'in', ids)
      .where('created_at', '>=', since30)
      .groupBy('user_id')
      .execute()
      .then((r) => new Map(r.map((x) => [x.user_id, x]))),
  ]);

  const [mailboxCounts, ruleCounts] = await Promise.all([
    db
      .selectFrom('accounts')
      .select((eb) => ['user_id', eb.fn.countAll().as('c')])
      .where('user_id', 'in', ids)
      .groupBy('user_id')
      .execute()
      .then((r) => new Map(r.map((x) => [x.user_id, num(x.c)]))),
    db
      .selectFrom('rules')
      .select((eb) => ['user_id', eb.fn.countAll().as('c')])
      .where('user_id', 'in', ids)
      .groupBy('user_id')
      .execute()
      .then((r) => new Map(r.map((x) => [x.user_id, num(x.c)]))),
  ]);

  const users: AdminUserRow[] = rows.map((row) => {
    const plan = getPlan(row.plan);
    const mailboxes = mailboxCounts.get(row.id) ?? 0;
    const rules = ruleCounts.get(row.id) ?? 0;
    const recent = num(counts.get(row.id)?.recent);
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      isAdmin: row.is_admin === 1,
      status: row.status,
      plan: row.plan,
      planName: plan.name,
      twoFactorEnabled: row.totp_enabled === 1,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      lastSeenAt: row.last_seen_at,
      loginCount: num(row.login_count),
      mailboxes,
      rules,
      jobsTotal: num(jobStats.get(row.id)?.jobs_total),
      jobsLast30Days: recent,
      messagesDeleted: num(jobStats.get(row.id)?.deleted),
      storageBytes: num(storage.get(row.id)?.bytes),
      trackedItems: num(storage.get(row.id)?.tracked_items),
      activity: activityOf(row.last_seen_at),
      quota: {
        mailboxes: { used: mailboxes, limit: plan.limits.mailboxes },
        jobsPerMonth: {
          used: recent,
          limit: Number.isFinite(plan.limits.jobsPerMonth) ? plan.limits.jobsPerMonth : null,
        },
        rules: { used: rules, limit: plan.limits.rules },
      },
    };
  });

  return { users, total };
}

// ---------------------------------------------------------------------------
// Dashboard overview
// ---------------------------------------------------------------------------

export interface AdminOverview {
  users: { total: number; active7d: number; new30d: number; suspended: number; withTwoFactor: number };
  mailboxes: { total: number; byProvider: Array<{ provider: string; count: number }>; needingReauth: number };
  jobs: { total: number; last30d: number; running: number; failed30d: number };
  messages: { deletedTotal: number; deletedLast30d: number };
  storage: { totalBytes: number; trackedItems: number };
  plans: Array<{ plan: PlanId; name: string; users: number; mrrCents: number }>;
  /** Daily buckets for the last 30 days, oldest first. */
  timeline: Array<{ date: string; signups: number; jobs: number; deleted: number }>;
  generatedAt: string;
}

export async function overview(): Promise<AdminOverview> {
  const db = await getDb();
  const now = Date.now();
  const since7 = new Date(now - 7 * 86_400_000).toISOString();
  const since30 = new Date(now - 30 * 86_400_000).toISOString();

  // Kysely's typed count needs a concrete builder per table, so counts go
  // through one small raw helper rather than a generic that fights the types.
  const countWhere = async (table: string, clause = ''): Promise<number> => {
    const text = `SELECT COUNT(*) AS c FROM ${table}${clause ? ` WHERE ${clause}` : ''}`;
    const result = await sql.raw<{ c: number | string }>(text).execute(db);
    return num(result.rows[0]?.c);
  };

  const [total, active7d, new30d, suspended, withTwoFactor] = await Promise.all([
    countWhere('users'),
    countWhere('users', `last_seen_at >= ${lit(since7)}`),
    countWhere('users', `created_at >= ${lit(since30)}`),
    countWhere('users', `status = ${lit('suspended')}`),
    countWhere('users', 'totp_enabled = 1'),
  ]);

  const [mailboxTotal, needingReauth, providerRows] = await Promise.all([
    countWhere('accounts'),
    countWhere('accounts', `status = ${lit('needs_reauth')}`),
    db
      .selectFrom('accounts')
      .select((eb) => ['provider', eb.fn.countAll().as('c')])
      .groupBy('provider')
      .execute(),
  ]);

  const [jobsTotal, jobsLast30d, running, failed30d] = await Promise.all([
    countWhere('jobs'),
    countWhere('jobs', `created_at >= ${lit(since30)}`),
    countWhere('jobs', `status IN ('running','previewing','queued','queued_execute')`),
    countWhere('jobs', `status = ${lit('failed')} AND created_at >= ${lit(since30)}`),
  ]);

  const deletedTotalRow = await db.selectFrom('jobs').select((eb) => eb.fn.sum('deleted_count').as('c')).executeTakeFirst();
  const deleted30Row = await db
    .selectFrom('jobs')
    .select((eb) => eb.fn.sum('deleted_count').as('c'))
    .where('created_at', '>=', since30)
    .executeTakeFirst();

  const storageRows = await sql
    .raw<{ user_id: string; bytes: number; tracked_items: number }>(STORAGE_SQL)
    .execute(db);
  const totalBytes = storageRows.rows.reduce((sum, r) => sum + num(r.bytes), 0);
  const trackedItems = storageRows.rows.reduce((sum, r) => sum + num(r.tracked_items), 0);

  const planRows = await db
    .selectFrom('users')
    .select((eb) => ['plan', eb.fn.countAll().as('c')])
    .groupBy('plan')
    .execute();

  const plans = (['free', 'pro', 'business'] as PlanId[]).map((id) => {
    const plan = getPlan(id);
    const users = num(planRows.find((r) => r.plan === id)?.c);
    return { plan: id, name: plan.name, users, mrrCents: users * plan.priceMonthlyCents };
  });

  // Date bucketing differs per dialect, so the grouping is done in JS over a
  // bounded window rather than with engine-specific SQL.
  const [signupRows, jobRows] = await Promise.all([
    db.selectFrom('users').select(['created_at']).where('created_at', '>=', since30).execute(),
    db.selectFrom('jobs').select(['created_at', 'deleted_count']).where('created_at', '>=', since30).execute(),
  ]);

  const buckets = new Map<string, { date: string; signups: number; jobs: number; deleted: number }>();
  for (let d = 29; d >= 0; d--) {
    const date = new Date(now - d * 86_400_000).toISOString().slice(0, 10);
    buckets.set(date, { date, signups: 0, jobs: 0, deleted: 0 });
  }
  for (const row of signupRows) {
    const b = buckets.get(row.created_at.slice(0, 10));
    if (b) b.signups++;
  }
  for (const row of jobRows) {
    const b = buckets.get(row.created_at.slice(0, 10));
    if (b) {
      b.jobs++;
      b.deleted += num(row.deleted_count);
    }
  }

  return {
    users: { total, active7d, new30d, suspended, withTwoFactor },
    mailboxes: {
      total: mailboxTotal,
      byProvider: providerRows.map((r) => ({ provider: r.provider, count: num(r.c) })),
      needingReauth,
    },
    jobs: { total: jobsTotal, last30d: jobsLast30d, running, failed30d },
    messages: { deletedTotal: num(deletedTotalRow?.c), deletedLast30d: num(deleted30Row?.c) },
    storage: { totalBytes, trackedItems },
    plans,
    timeline: [...buckets.values()],
    generatedAt: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

async function loadUser(userId: string) {
  const db = await getDb();
  const row = await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();
  if (!row) throw notFound('User');
  return row;
}

export async function setUserPlan(adminId: string, userId: string, plan: PlanId): Promise<void> {
  await loadUser(userId);
  const db = await getDb();
  await db
    .updateTable('users')
    .set({ plan, plan_started_at: nowIso(), updated_at: nowIso() })
    .where('id', '=', userId)
    .execute();
  await audit({ userId: adminId, action: 'admin.plan_changed', detail: { targetUser: userId, plan } });
}

export async function setUserStatus(adminId: string, userId: string, status: UserStatus): Promise<void> {
  const row = await loadUser(userId);
  if (row.is_admin === 1 && status === 'suspended') {
    throw forbidden('Administrators cannot be suspended. Remove the admin flag first.');
  }
  const db = await getDb();
  await db.updateTable('users').set({ status, updated_at: nowIso() }).where('id', '=', userId).execute();
  await audit({ userId: adminId, action: 'admin.status_changed', detail: { targetUser: userId, status } });
}

/** Lets an admin unblock someone who lost their authenticator. */
export async function resetUserTwoFactor(adminId: string, userId: string): Promise<void> {
  await loadUser(userId);
  const db = await getDb();
  await db
    .updateTable('users')
    .set({
      totp_enabled: 0,
      totp_secret_enc: null,
      totp_confirmed_at: null,
      backup_codes_json: null,
      updated_at: nowIso(),
    })
    .where('id', '=', userId)
    .execute();
  await audit({ userId: adminId, action: 'admin.2fa_reset', detail: { targetUser: userId } });
}

export async function deleteUser(adminId: string, userId: string): Promise<void> {
  const row = await loadUser(userId);
  if (row.is_admin === 1) throw forbidden('Remove the admin flag before deleting this account.');
  const db = await getDb();
  // Cascades remove accounts, rules, jobs and job items.
  await db.deleteFrom('users').where('id', '=', userId).execute();
  await audit({ userId: adminId, action: 'admin.user_deleted', detail: { targetUser: userId, email: row.email } });
}

/** Per-user detail pane: quota, mailboxes (metadata only) and recent activity. */
export async function userDetail(userId: string) {
  const row = await loadUser(userId);
  const db = await getDb();
  const [usage, accounts, recentJobs, auditRows] = await Promise.all([
    currentUsage(userId),
    db
      .selectFrom('accounts')
      .select(['id', 'provider', 'email', 'status', 'status_detail', 'created_at', 'last_connected_at'])
      .where('user_id', '=', userId)
      .execute(),
    db
      .selectFrom('jobs')
      .select(['id', 'status', 'mode', 'matched_count', 'deleted_count', 'created_at', 'finished_at'])
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .limit(20)
      .execute(),
    db
      .selectFrom('audit_log')
      .select(['action', 'created_at', 'ip'])
      .where('user_id', '=', userId)
      .orderBy('id', 'desc')
      .limit(30)
      .execute(),
  ]);

  const plan = getPlan(row.plan);
  return {
    user: {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      isAdmin: row.is_admin === 1,
      status: row.status,
      plan: row.plan,
      planName: plan.name,
      twoFactorEnabled: row.totp_enabled === 1,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      lastSeenAt: row.last_seen_at,
      loginCount: num(row.login_count),
      acceptedTermsAt: row.accepted_terms_at,
    },
    usage,
    plan: { ...plan, limits: { ...plan.limits, jobsPerMonth: Number.isFinite(plan.limits.jobsPerMonth) ? plan.limits.jobsPerMonth : null } },
    accounts,
    recentJobs,
    recentActivity: auditRows,
  };
}
