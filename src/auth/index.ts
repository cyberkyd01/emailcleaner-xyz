import { createHash, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb, isoIn, nowIso } from '../db/index.js';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../lib/crypto.js';
import { newId } from '../lib/ids.js';
import { badRequest, conflict, forbidden, tooManyRequests, unauthorized } from '../lib/errors.js';
import {
  generateBackupCodes,
  generateTotpSecret,
  normaliseBackupCode,
  otpauthUri,
  verifyTotp,
} from '../lib/totp.js';
import { audit } from '../services/audit.js';
import type { PlanId, UserTable, UserStatus } from '../db/types.js';

export const SESSION_COOKIE = 'ec_session';
const SESSION_TTL = '7d';
const MFA_CHALLENGE_TTL_MS = 5 * 60_000;
const MFA_MAX_ATTEMPTS = 6;

export interface SessionUser {
  id: string;
  email: string;
  isAdmin: boolean;
}

export interface PublicUser extends SessionUser {
  displayName: string | null;
  plan: PlanId;
  status: UserStatus;
  twoFactorEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  backupCodesRemaining: number;
}

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  // Long enough to resist guessing; the rest is the operator's policy call.
  password: z.string().min(10).max(1024),
  captchaToken: z.string().max(4096).optional(),
  acceptTerms: z.boolean().optional(),
});

export const toPublicUser = (row: UserTable): PublicUser => ({
  id: row.id,
  email: row.email,
  isAdmin: row.is_admin === 1,
  displayName: row.display_name,
  plan: row.plan,
  status: row.status,
  twoFactorEnabled: row.totp_enabled === 1,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
  backupCodesRemaining: unusedBackupCodes(row.backup_codes_json).length,
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

let cachedKey: Uint8Array | null = null;
const signingKey = (): Uint8Array => {
  if (cachedKey) return cachedKey;
  if (!config.sessionSecret) throw new Error('SESSION_SECRET is not set — run `npm run keygen`');
  cachedKey = new Uint8Array(Buffer.from(config.sessionSecret, 'base64'));
  if (cachedKey.length < 32) throw new Error('SESSION_SECRET must decode to at least 32 bytes');
  return cachedKey;
};

export async function issueSession(user: SessionUser): Promise<string> {
  return new SignJWT({ email: user.email, admin: user.isAdmin })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(signingKey());
}

export async function readSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, signingKey());
    if (!payload.sub) return null;
    return { id: payload.sub, email: String(payload.email ?? ''), isAdmin: payload.admin === true };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

async function recordAttempt(identifier: string, ip: string | undefined, success: boolean): Promise<void> {
  const db = await getDb();
  await db
    .insertInto('login_attempts')
    .values({ identifier, ip: ip ?? null, success: success ? 1 : 0, created_at: nowIso() })
    .execute();
}

/**
 * Counts recent failures for an identifier. Successful logins reset the count,
 * so a legitimate user who mistypes twice is never locked out by yesterday.
 */
async function assertNotLockedOut(identifier: string): Promise<void> {
  const db = await getDb();
  const since = new Date(Date.now() - config.auth.lockoutMinutes * 60_000).toISOString();
  const rows = await db
    .selectFrom('login_attempts')
    .select(['success', 'created_at'])
    .where('identifier', '=', identifier)
    .where('created_at', '>=', since)
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute();

  let failures = 0;
  for (const row of rows) {
    if (row.success === 1) break;
    failures++;
  }
  if (failures >= config.auth.maxLoginAttempts) {
    throw tooManyRequests(
      `Too many failed sign-in attempts. Try again in ${config.auth.lockoutMinutes} minutes.`,
      config.auth.lockoutMinutes * 60,
    );
  }
}

/** Housekeeping so the table does not grow without bound. */
export async function pruneAuthTables(): Promise<void> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  await db.deleteFrom('login_attempts').where('created_at', '<', cutoff).execute();
  await db.deleteFrom('mfa_challenges').where('expires_at', '<', nowIso()).execute();
}

// ---------------------------------------------------------------------------
// Registration and sign-in
// ---------------------------------------------------------------------------

export async function registerUser(
  email: string,
  password: string,
  opts: { acceptedTerms?: boolean } = {},
): Promise<PublicUser> {
  if (!config.allowRegistration) {
    throw forbidden('Registration is closed on this deployment.');
  }
  const db = await getDb();
  const existing = await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
  if (existing) throw conflict('An account with that email already exists.');

  // The first account to register administers the deployment.
  const anyUser = await db.selectFrom('users').select('id').limit(1).executeTakeFirst();
  const id = newId('usr');
  const now = nowIso();

  await db
    .insertInto('users')
    .values({
      id,
      email,
      password_hash: await hashPassword(password),
      is_admin: anyUser ? 0 : 1,
      created_at: now,
      updated_at: now,
      totp_secret_enc: null,
      totp_enabled: 0,
      totp_confirmed_at: null,
      backup_codes_json: null,
      display_name: null,
      plan: 'free',
      plan_started_at: now,
      status: 'active',
      last_login_at: now,
      last_seen_at: now,
      login_count: 1,
      accepted_terms_at: opts.acceptedTerms ? now : null,
    })
    .execute();

  await audit({ userId: id, action: 'user.registered', detail: { email, admin: !anyUser } });
  return toPublicUser(await requireUserRow(id));
}

export type LoginOutcome =
  | { status: 'ok'; user: PublicUser }
  | { status: 'mfa_required'; challengeId: string; expiresAt: string };

export async function authenticate(
  email: string,
  password: string,
  ip: string | undefined,
): Promise<LoginOutcome> {
  await assertNotLockedOut(email);

  const db = await getDb();
  const row = await db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();

  // Hash even when the user does not exist, so timing does not reveal accounts.
  const hash = row?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA';
  const ok = await verifyPassword(password, hash);

  if (!row || !ok) {
    await recordAttempt(email, ip, false);
    await audit({ action: 'user.login_failed', detail: { email }, ip });
    throw unauthorized('Incorrect email or password.');
  }

  if (row.status === 'suspended') {
    await recordAttempt(email, ip, false);
    await audit({ userId: row.id, action: 'user.login_suspended', ip });
    throw forbidden('This account has been suspended. Contact support.');
  }

  if (row.totp_enabled === 1) {
    // The password alone never produces a session once 2FA is on.
    const challengeId = newId('mfa');
    await db
      .insertInto('mfa_challenges')
      .values({
        id: challengeId,
        user_id: row.id,
        attempts: 0,
        ip: ip ?? null,
        created_at: nowIso(),
        expires_at: isoIn(MFA_CHALLENGE_TTL_MS),
      })
      .execute();
    await audit({ userId: row.id, action: 'user.mfa_challenged', ip });
    return { status: 'mfa_required', challengeId, expiresAt: isoIn(MFA_CHALLENGE_TTL_MS) };
  }

  await completeLogin(row.id, ip);
  await recordAttempt(email, ip, true);
  return { status: 'ok', user: toPublicUser(await requireUserRow(row.id)) };
}

async function completeLogin(userId: string, ip: string | undefined): Promise<void> {
  const db = await getDb();
  const now = nowIso();
  await db
    .updateTable('users')
    .set((eb) => ({
      last_login_at: now,
      last_seen_at: now,
      login_count: eb('login_count', '+', 1),
      updated_at: now,
    }))
    .where('id', '=', userId)
    .execute();
  await audit({ userId, action: 'user.login', ip });
}

/** Second factor of the sign-in: a TOTP code or one recovery code. */
export async function completeMfaChallenge(
  challengeId: string,
  code: string,
  ip: string | undefined,
): Promise<PublicUser> {
  const db = await getDb();
  const challenge = await db
    .selectFrom('mfa_challenges')
    .selectAll()
    .where('id', '=', challengeId)
    .executeTakeFirst();

  if (!challenge || new Date(challenge.expires_at) < new Date()) {
    if (challenge) await db.deleteFrom('mfa_challenges').where('id', '=', challengeId).execute();
    throw unauthorized('That sign-in attempt expired. Start again.');
  }
  if (challenge.attempts >= MFA_MAX_ATTEMPTS) {
    await db.deleteFrom('mfa_challenges').where('id', '=', challengeId).execute();
    throw tooManyRequests('Too many incorrect codes. Start the sign-in again.');
  }

  const row = await requireUserRow(challenge.user_id);
  const accepted = await consumeSecondFactor(row, code);

  if (!accepted) {
    await db
      .updateTable('mfa_challenges')
      .set({ attempts: challenge.attempts + 1 })
      .where('id', '=', challengeId)
      .execute();
    await recordAttempt(row.email, ip, false);
    await audit({ userId: row.id, action: 'user.mfa_failed', ip });
    throw unauthorized('That code is not valid.');
  }

  await db.deleteFrom('mfa_challenges').where('id', '=', challengeId).execute();
  await completeLogin(row.id, ip);
  await recordAttempt(row.email, ip, true);
  return toPublicUser(await requireUserRow(row.id));
}

/**
 * Accepts either a live TOTP code or an unused recovery code. Recovery codes
 * are single use and are burned here.
 */
async function consumeSecondFactor(row: UserTable, code: string): Promise<boolean> {
  const trimmed = code.trim();

  if (row.totp_secret_enc) {
    const secret = decryptSecret(row.totp_secret_enc, row.id);
    if (verifyTotp(secret, trimmed)) return true;
  }

  const normalised = normaliseBackupCode(trimmed);
  if (normalised.length < 8) return false;

  const codes = parseBackupCodes(row.backup_codes_json);
  const target = hashBackupCode(normalised);
  const match = codes.find((c) => c.usedAt === null && constantTimeHexEquals(c.hash, target));
  if (!match) return false;

  match.usedAt = nowIso();
  const db = await getDb();
  await db
    .updateTable('users')
    .set({ backup_codes_json: JSON.stringify(codes), updated_at: nowIso() })
    .where('id', '=', row.id)
    .execute();
  await audit({ userId: row.id, action: 'user.backup_code_used', detail: { remaining: codes.filter((c) => !c.usedAt).length } });
  return true;
}

// ---------------------------------------------------------------------------
// Two-factor enrolment
// ---------------------------------------------------------------------------

interface StoredBackupCode {
  hash: string;
  usedAt: string | null;
}

/**
 * Recovery codes are 50-bit random strings, not user-chosen passwords, so a
 * fast hash is the right trade-off: there is nothing to brute force, and
 * verification has to compare against every unused code.
 */
const hashBackupCode = (code: string): string =>
  createHash('sha256').update(`${code}:${config.sessionSecret ?? ''}`).digest('hex');

const parseBackupCodes = (json: string | null): StoredBackupCode[] => {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as StoredBackupCode[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const unusedBackupCodes = (json: string | null): StoredBackupCode[] =>
  parseBackupCodes(json).filter((c) => c.usedAt === null);

function constantTimeHexEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

export interface TwoFactorSetup {
  secret: string;
  otpauthUri: string;
}

/** Generates a pending secret. It is not active until confirmed with a code. */
export async function beginTwoFactorSetup(userId: string): Promise<TwoFactorSetup> {
  const row = await requireUserRow(userId);
  if (row.totp_enabled === 1) {
    throw conflict('Two-factor authentication is already on. Turn it off before re-enrolling.');
  }

  const secret = generateTotpSecret();
  const db = await getDb();
  await db
    .updateTable('users')
    .set({ totp_secret_enc: encryptSecret(secret, userId), updated_at: nowIso() })
    .where('id', '=', userId)
    .execute();

  return {
    secret,
    otpauthUri: otpauthUri({ secret, account: row.email, issuer: config.brand.name }),
  };
}

/** Confirms enrolment and returns the recovery codes, shown exactly once. */
export async function confirmTwoFactorSetup(userId: string, code: string): Promise<string[]> {
  const row = await requireUserRow(userId);
  if (!row.totp_secret_enc) throw badRequest('Start the two-factor setup first.');
  if (row.totp_enabled === 1) throw conflict('Two-factor authentication is already on.');

  const secret = decryptSecret(row.totp_secret_enc, userId);
  if (!verifyTotp(secret, code)) {
    throw badRequest('That code is not valid. Check your authenticator app and try again.');
  }

  const codes = generateBackupCodes(10);
  const stored: StoredBackupCode[] = codes.map((c) => ({
    hash: hashBackupCode(normaliseBackupCode(c)),
    usedAt: null,
  }));

  const db = await getDb();
  const now = nowIso();
  await db
    .updateTable('users')
    .set({
      totp_enabled: 1,
      totp_confirmed_at: now,
      backup_codes_json: JSON.stringify(stored),
      updated_at: now,
    })
    .where('id', '=', userId)
    .execute();

  await audit({ userId, action: 'user.2fa_enabled' });
  return codes;
}

/** Turning 2FA off requires the password, so a stolen session cannot do it. */
export async function disableTwoFactor(userId: string, password: string): Promise<void> {
  const row = await requireUserRow(userId);
  if (!(await verifyPassword(password, row.password_hash))) {
    throw unauthorized('Password is incorrect.');
  }
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
  await audit({ userId, action: 'user.2fa_disabled' });
}

export async function regenerateBackupCodes(userId: string, password: string): Promise<string[]> {
  const row = await requireUserRow(userId);
  if (!(await verifyPassword(password, row.password_hash))) {
    throw unauthorized('Password is incorrect.');
  }
  if (row.totp_enabled !== 1) throw badRequest('Two-factor authentication is not enabled.');

  const codes = generateBackupCodes(10);
  const stored: StoredBackupCode[] = codes.map((c) => ({
    hash: hashBackupCode(normaliseBackupCode(c)),
    usedAt: null,
  }));
  const db = await getDb();
  await db
    .updateTable('users')
    .set({ backup_codes_json: JSON.stringify(stored), updated_at: nowIso() })
    .where('id', '=', userId)
    .execute();
  await audit({ userId, action: 'user.backup_codes_regenerated' });
  return codes;
}

// ---------------------------------------------------------------------------
// Account maintenance
// ---------------------------------------------------------------------------

export async function requireUserRow(userId: string): Promise<UserTable> {
  const db = await getDb();
  const row = await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();
  if (!row) throw unauthorized('Account no longer exists.');
  return row;
}

export async function changePassword(userId: string, current: string, next: string): Promise<void> {
  if (next.length < 10) throw badRequest('The new password must be at least 10 characters.');
  const row = await requireUserRow(userId);
  if (!(await verifyPassword(current, row.password_hash))) {
    throw unauthorized('Current password is incorrect.');
  }
  const db = await getDb();
  await db
    .updateTable('users')
    .set({ password_hash: await hashPassword(next), updated_at: nowIso() })
    .where('id', '=', userId)
    .execute();
  await audit({ userId, action: 'user.password_changed' });
}

export async function updateProfile(userId: string, displayName: string | null): Promise<PublicUser> {
  const db = await getDb();
  await db
    .updateTable('users')
    .set({ display_name: displayName, updated_at: nowIso() })
    .where('id', '=', userId)
    .execute();
  return toPublicUser(await requireUserRow(userId));
}

/** Cheap heartbeat so the admin dashboard can show real activity. */
export async function touchLastSeen(userId: string): Promise<void> {
  const db = await getDb();
  await db.updateTable('users').set({ last_seen_at: nowIso() }).where('id', '=', userId).execute();
}
