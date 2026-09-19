import { getDb } from '../db/index.js';
import { forbidden } from '../lib/errors.js';
import type { PlanId } from '../db/types.js';

/**
 * Plan definitions live here rather than in the pricing page markup, so the
 * page, the API and the enforcement path can never disagree about what a plan
 * includes. The pricing page renders straight from this list.
 */
export interface PlanLimits {
  /** Connected mailboxes. */
  mailboxes: number;
  /** Cleaning jobs that may be started in a rolling 30-day window. */
  jobsPerMonth: number;
  /** Saved rules, scheduled or manual. */
  rules: number;
  /** Scheduled (cron) rules. 0 disables scheduling on the plan. */
  scheduledRules: number;
  /** Ceiling on messages a single job may act on. */
  messagesPerJob: number;
  /** How long completed jobs stay undoable. */
  undoWindowDays: number;
  /** How long job history is retained. */
  historyRetentionDays: number;
}

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  /** Monthly price in the smallest currency unit, so no float arithmetic. */
  priceMonthlyCents: number;
  priceYearlyCents: number;
  currency: string;
  /** Rendered as ticks on the pricing page, in order. */
  highlights: string[];
  limits: PlanLimits;
  /** Drives the "most popular" treatment. */
  featured?: boolean;
  /** Shown instead of a price when the plan is sales-led. */
  contactSales?: boolean;
}

export const PLANS: readonly Plan[] = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'Clean one mailbox and see exactly how it works.',
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    currency: 'USD',
    highlights: [
      'One connected mailbox',
      'Gmail, Outlook, Yahoo, iCloud and any IMAP host',
      'Clean by section or by keyword',
      'Preview before every deletion',
      '7-day undo window',
      '10 cleaning jobs a month',
    ],
    limits: {
      mailboxes: 1,
      jobsPerMonth: 10,
      rules: 3,
      scheduledRules: 0,
      messagesPerJob: 5_000,
      undoWindowDays: 7,
      historyRetentionDays: 30,
    },
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'For a mailbox that has got away from you.',
    priceMonthlyCents: 900,
    priceYearlyCents: 9_000,
    currency: 'USD',
    featured: true,
    highlights: [
      'Five connected mailboxes',
      'Unlimited cleaning jobs',
      'Scheduled rules that run themselves',
      '30-day undo window',
      'Up to 50,000 messages per job',
      'Full audit log and export',
      'Email support',
    ],
    limits: {
      mailboxes: 5,
      jobsPerMonth: Number.POSITIVE_INFINITY,
      rules: 50,
      scheduledRules: 20,
      messagesPerJob: 50_000,
      undoWindowDays: 30,
      historyRetentionDays: 365,
    },
  },
  {
    id: 'business',
    name: 'Business',
    tagline: 'Teams, shared mailboxes and retention policies.',
    priceMonthlyCents: 2_900,
    priceYearlyCents: 29_000,
    currency: 'USD',
    highlights: [
      'Twenty-five connected mailboxes',
      'Everything in Pro',
      'Priority provider rate limits',
      'Retention-policy rules',
      '90-day undo window',
      'Audit-log export for compliance',
      'Priority support',
    ],
    limits: {
      mailboxes: 25,
      jobsPerMonth: Number.POSITIVE_INFINITY,
      rules: 500,
      scheduledRules: 200,
      messagesPerJob: 250_000,
      undoWindowDays: 90,
      historyRetentionDays: 1095,
    },
  },
] as const;

export const getPlan = (id: PlanId | string): Plan =>
  PLANS.find((p) => p.id === id) ?? (PLANS[0] as Plan);

/** JSON-safe view: Infinity does not survive JSON.stringify. */
export const planToJson = (plan: Plan) => ({
  ...plan,
  limits: {
    ...plan.limits,
    jobsPerMonth: Number.isFinite(plan.limits.jobsPerMonth) ? plan.limits.jobsPerMonth : null,
  },
});

export const publicPlans = () => PLANS.map(planToJson);

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

export interface PlanUsage {
  mailboxes: number;
  jobsLast30Days: number;
  rules: number;
  scheduledRules: number;
}

export async function currentUsage(userId: string): Promise<PlanUsage> {
  const db = await getDb();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const count = async (build: () => Promise<{ c: number | string | bigint } | undefined>): Promise<number> =>
    Number((await build())?.c ?? 0);

  const [mailboxes, jobsLast30Days, rules, scheduledRules] = await Promise.all([
    count(() =>
      db.selectFrom('accounts').select((eb) => eb.fn.countAll().as('c')).where('user_id', '=', userId).executeTakeFirst(),
    ),
    count(() =>
      db
        .selectFrom('jobs')
        .select((eb) => eb.fn.countAll().as('c'))
        .where('user_id', '=', userId)
        .where('created_at', '>=', since)
        .executeTakeFirst(),
    ),
    count(() =>
      db.selectFrom('rules').select((eb) => eb.fn.countAll().as('c')).where('user_id', '=', userId).executeTakeFirst(),
    ),
    count(() =>
      db
        .selectFrom('rules')
        .select((eb) => eb.fn.countAll().as('c'))
        .where('user_id', '=', userId)
        .where('schedule_cron', 'is not', null)
        .executeTakeFirst(),
    ),
  ]);

  return { mailboxes, jobsLast30Days, rules, scheduledRules };
}

async function planFor(userId: string): Promise<Plan> {
  const db = await getDb();
  const row = await db.selectFrom('users').select('plan').where('id', '=', userId).executeTakeFirst();
  return getPlan(row?.plan ?? 'free');
}

/**
 * Administrators are not subject to plan quotas.
 *
 * Plans exist to price a hosted product. On a self-hosted deployment the person
 * who runs the server is also the person the limits would throttle, which is
 * pointless friction — they can lift any limit from the admin panel anyway, so
 * enforcing it only adds steps.
 */
async function isUnlimited(userId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db
    .selectFrom('users')
    .select(['is_admin', 'status'])
    .where('id', '=', userId)
    .executeTakeFirst();
  return row?.is_admin === 1 && row.status === 'active';
}

const upgradeHint = (plan: Plan): string =>
  plan.id === 'business' ? 'Contact support to raise this limit.' : 'Upgrade your plan to raise this limit.';

/** Called before connecting a mailbox. */
export async function assertCanAddMailbox(userId: string): Promise<void> {
  if (await isUnlimited(userId)) return;
  const [plan, usage] = await Promise.all([planFor(userId), currentUsage(userId)]);
  if (usage.mailboxes >= plan.limits.mailboxes) {
    throw forbidden(
      `The ${plan.name} plan covers ${plan.limits.mailboxes} mailbox${plan.limits.mailboxes === 1 ? '' : 'es'} and you have ${usage.mailboxes}. ${upgradeHint(plan)}`,
    );
  }
}

/** Called before queuing a job. */
export async function assertCanStartJob(userId: string): Promise<void> {
  if (await isUnlimited(userId)) return;
  const [plan, usage] = await Promise.all([planFor(userId), currentUsage(userId)]);
  if (usage.jobsLast30Days >= plan.limits.jobsPerMonth) {
    throw forbidden(
      `The ${plan.name} plan allows ${plan.limits.jobsPerMonth} cleaning jobs per 30 days and you have run ${usage.jobsLast30Days}. ${upgradeHint(plan)}`,
    );
  }
}

/** Called before saving a rule. */
export async function assertCanAddRule(userId: string, scheduled: boolean): Promise<void> {
  if (await isUnlimited(userId)) return;
  const [plan, usage] = await Promise.all([planFor(userId), currentUsage(userId)]);
  if (usage.rules >= plan.limits.rules) {
    throw forbidden(`The ${plan.name} plan allows ${plan.limits.rules} saved rules. ${upgradeHint(plan)}`);
  }
  if (scheduled && plan.limits.scheduledRules === 0) {
    throw forbidden(`Scheduled rules are not part of the ${plan.name} plan. ${upgradeHint(plan)}`);
  }
  if (scheduled && usage.scheduledRules >= plan.limits.scheduledRules) {
    throw forbidden(
      `The ${plan.name} plan allows ${plan.limits.scheduledRules} scheduled rules. ${upgradeHint(plan)}`,
    );
  }
}

/** The per-job message ceiling, which overrides the global cap when lower. */
export async function jobMessageCeiling(userId: string, globalCap: number): Promise<number> {
  if (await isUnlimited(userId)) return globalCap;
  const plan = await planFor(userId);
  return Math.min(globalCap, plan.limits.messagesPerJob);
}

export async function undoWindowDaysFor(userId: string, globalDefault: number): Promise<number> {
  if (await isUnlimited(userId)) return globalDefault;
  const plan = await planFor(userId);
  return Math.min(globalDefault, plan.limits.undoWindowDays);
}
