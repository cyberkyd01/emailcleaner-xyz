import { z } from 'zod';
import { config } from '../config.js';
import { getDb, nowIso } from '../db/index.js';
import { badRequest, tooManyRequests } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { sendMailSafely } from '../lib/mailer.js';
import { getPlan } from './plans.js';
import { audit } from './audit.js';

export const interestSchema = z
  .object({
    name: z.string().trim().max(120).optional(),
    email: z.string().trim().toLowerCase().email().max(254),
    company: z.string().trim().max(160).optional(),
    phone: z.string().trim().max(40).optional(),
    plan: z.enum(['free', 'pro', 'business', 'undecided']).default('undecided'),
    mailboxes: z.enum(['1', '2-5', '6-25', '25+']).optional(),
    message: z.string().trim().max(2000).optional(),
    source: z.string().trim().max(60).optional(),
    captchaToken: z.string().max(4096).optional(),
    /** Honeypot: a real person never fills this in, it is hidden from view. */
    website: z.string().max(200).optional(),
  })
  .strict();

export type InterestInput = z.infer<typeof interestSchema>;

/** Rate limit by IP so the public endpoint cannot be used to flood the inbox. */
async function assertNotFlooding(ip: string | undefined): Promise<void> {
  if (!ip) return;
  const db = await getDb();
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const row = await db
    .selectFrom('waitlist')
    .select((eb) => eb.fn.countAll().as('c'))
    .where('ip', '=', ip)
    .where('created_at', '>=', since)
    .executeTakeFirst();
  if (Number(row?.c ?? 0) >= 5) {
    throw tooManyRequests('You have already submitted a few requests. We will be in touch shortly.');
  }
}

export interface SubmitResult {
  ok: true;
  duplicate: boolean;
}

export async function submitInterest(
  input: InterestInput,
  meta: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<SubmitResult> {
  // Silently accept and discard honeypot hits: telling a bot it failed only
  // helps it learn.
  if (input.website && input.website.length > 0) {
    logger.debug('interest form honeypot triggered', { ip: meta.ip });
    return { ok: true, duplicate: false };
  }

  await assertNotFlooding(meta.ip);

  const db = await getDb();
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const existing = await db
    .selectFrom('waitlist')
    .select('id')
    .where('email', '=', input.email)
    .where('created_at', '>=', since)
    .executeTakeFirst();

  if (existing) {
    // Do not email again for a same-day resubmission, but do not error either.
    return { ok: true, duplicate: true };
  }

  const now = nowIso();
  await db
    .insertInto('waitlist')
    .values({
      name: input.name ?? null,
      email: input.email,
      company: input.company ?? null,
      phone: input.phone ?? null,
      plan: input.plan,
      mailboxes: input.mailboxes ?? null,
      message: input.message ?? null,
      source: input.source ?? null,
      ip: meta.ip ?? null,
      user_agent: (meta.userAgent ?? '').slice(0, 300) || null,
      notified: 0,
      contacted: 0,
      created_at: now,
    })
    .execute();

  await audit({ action: 'waitlist.submitted', detail: { email: input.email, plan: input.plan }, ip: meta.ip });

  const planLabel = input.plan === 'undecided' ? 'Undecided' : getPlan(input.plan).name;
  const lines = [
    'New access request from the Email Cleaner site.',
    '',
    `Name      : ${input.name || '—'}`,
    `Email     : ${input.email}`,
    `Company   : ${input.company || '—'}`,
    `Phone     : ${input.phone || '—'}`,
    `Plan      : ${planLabel}`,
    `Mailboxes : ${input.mailboxes || '—'}`,
    '',
    'Message:',
    input.message ? input.message : '(none)',
    '',
    '—',
    `Submitted : ${now}`,
    `Source    : ${input.source || 'website'}`,
    `IP        : ${meta.ip || '—'}`,
    '',
    `Reply directly to this email to reach ${input.email}.`,
    `All requests: ${config.publicBaseUrl}/admin#waitlist`,
  ];

  sendMailSafely(
    {
      to: config.mail.notifyTo,
      subject: `Access request: ${input.email} (${planLabel})`,
      text: lines.join('\n'),
      // Hitting reply goes straight to the person who asked.
      replyTo: input.email,
    },
    { kind: 'waitlist', email: input.email },
  );

  return { ok: true, duplicate: false };
}

export interface WaitlistRow {
  id: number;
  name: string | null;
  email: string;
  company: string | null;
  phone: string | null;
  plan: string | null;
  mailboxes: string | null;
  message: string | null;
  source: string | null;
  ip: string | null;
  contacted: boolean;
  createdAt: string;
}

export async function listInterest(opts: { limit?: number; offset?: number } = {}): Promise<{
  entries: WaitlistRow[];
  total: number;
  byPlan: Array<{ plan: string; count: number }>;
}> {
  const db = await getDb();

  const totalRow = await db.selectFrom('waitlist').select((eb) => eb.fn.countAll().as('c')).executeTakeFirst();
  const planRows = await db
    .selectFrom('waitlist')
    .select((eb) => ['plan', eb.fn.countAll().as('c')])
    .groupBy('plan')
    .execute();

  const rows = await db
    .selectFrom('waitlist')
    .selectAll()
    .orderBy('id', 'desc')
    .limit(Math.min(opts.limit ?? 100, 500))
    .offset(opts.offset ?? 0)
    .execute();

  return {
    total: Number(totalRow?.c ?? 0),
    byPlan: planRows.map((r) => ({ plan: r.plan ?? 'undecided', count: Number(r.c) })),
    entries: rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      email: r.email,
      company: r.company,
      phone: r.phone,
      plan: r.plan,
      mailboxes: r.mailboxes,
      message: r.message,
      source: r.source,
      ip: r.ip,
      contacted: r.contacted === 1,
      createdAt: r.created_at,
    })),
  };
}

export async function markContacted(id: number, contacted: boolean): Promise<void> {
  const db = await getDb();
  await db.updateTable('waitlist').set({ contacted: contacted ? 1 : 0 }).where('id', '=', id).execute();
}

export async function deleteInterest(id: number): Promise<void> {
  const db = await getDb();
  await db.deleteFrom('waitlist').where('id', '=', id).execute();
}

/** CSV for the admin console, so the list can leave the system easily. */
export async function exportCsv(): Promise<string> {
  const { entries } = await listInterest({ limit: 500 });
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['id', 'created_at', 'name', 'email', 'company', 'phone', 'plan', 'mailboxes', 'message', 'contacted'];
  const body = entries.map((e) =>
    [e.id, e.createdAt, e.name, e.email, e.company, e.phone, e.plan, e.mailboxes, e.message, e.contacted].map(esc).join(','),
  );
  return [header.join(','), ...body].join('\n');
}
