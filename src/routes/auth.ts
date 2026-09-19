import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config, isCaptchaEnabled } from '../config.js';
import {
  authenticate,
  beginTwoFactorSetup,
  changePassword,
  completeMfaChallenge,
  confirmTwoFactorSetup,
  credentialsSchema,
  disableTwoFactor,
  issueSession,
  regenerateBackupCodes,
  registerUser,
  requireUserRow,
  SESSION_COOKIE,
  toPublicUser,
  touchLastSeen,
  updateProfile,
  type PublicUser,
} from '../auth/index.js';
import { assertCaptcha, captchaClientConfig } from '../lib/captcha.js';
import { badRequest } from '../lib/errors.js';
import { currentUsage, planToJson, getPlan } from '../services/plans.js';
import { currentUser, requireUser } from './plugin.js';

/**
 * Secure is set from the protocol the request actually arrived on, which
 * Fastify derives from X-Forwarded-Proto because trustProxy is enabled. Keying
 * it off PUBLIC_BASE_URL instead would mark the cookie Secure on a plain-HTTP
 * request and the browser would silently drop it.
 */
const cookieOptionsFor = (request: FastifyRequest) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: request.protocol === 'https',
  path: '/',
  maxAge: 7 * 24 * 60 * 60,
});

const clientIp = (request: FastifyRequest): string | undefined => request.ip;

async function startSession(
  request: FastifyRequest,
  reply: FastifyReply,
  user: PublicUser,
): Promise<{ user: PublicUser; token: string }> {
  const token = await issueSession({ id: user.id, email: user.email, isAdmin: user.isAdmin });
  reply.setCookie(SESSION_COOKIE, token, cookieOptionsFor(request));
  return { user, token };
}

const mfaSchema = z.object({
  challengeId: z.string().min(1).max(64),
  code: z.string().min(6).max(32),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** Everything the sign-in page needs to render itself correctly. */
  app.get('/api/auth/config', async () => ({
    registrationOpen: config.allowRegistration,
    captcha: captchaClientConfig(),
    enforce2fa: config.auth.enforce2fa,
    brand: { name: config.brand.name, supportEmail: config.brand.supportEmail },
  }));

  app.post('/api/auth/register', async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Provide a valid email and a password of at least 10 characters.');
    }
    if (!parsed.data.acceptTerms) {
      throw badRequest('You must accept the Terms of Service and Privacy Policy to create an account.');
    }
    await assertCaptcha(parsed.data.captchaToken, { action: 'register', ip: clientIp(request) });

    const user = await registerUser(parsed.data.email, parsed.data.password, { acceptedTerms: true });
    return startSession(request, reply, user);
  });

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Provide a valid email and password.');
    await assertCaptcha(parsed.data.captchaToken, { action: 'login', ip: clientIp(request) });

    const outcome = await authenticate(parsed.data.email, parsed.data.password, clientIp(request));
    if (outcome.status === 'mfa_required') {
      // No cookie is set here: the password alone is not a session.
      reply.code(200);
      return {
        mfaRequired: true,
        challengeId: outcome.challengeId,
        expiresAt: outcome.expiresAt,
      };
    }
    return { mfaRequired: false, ...(await startSession(request, reply, outcome.user)) };
  });

  /** Second step of a 2FA sign-in: TOTP code or a recovery code. */
  app.post('/api/auth/login/mfa', async (request, reply) => {
    const parsed = mfaSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Provide the challenge id and your code.');
    const user = await completeMfaChallenge(parsed.data.challengeId, parsed.data.code, clientIp(request));
    return { mfaRequired: false, ...(await startSession(request, reply, user)) };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireUser }, async (request) => {
    const session = currentUser(request);
    const row = await requireUserRow(session.id);
    void touchLastSeen(session.id);
    const plan = getPlan(row.plan);
    return {
      user: toPublicUser(row),
      plan: planToJson(plan),
      usage: await currentUsage(session.id),
      // Admins are exempt from quotas, so the UI shows usage without limits.
      unlimited: row.is_admin === 1 && row.status === 'active',
      registrationOpen: config.allowRegistration,
    };
  });

  app.patch('/api/auth/profile', { preHandler: requireUser }, async (request) => {
    const body = request.body as { displayName?: string | null } | undefined;
    const name = body?.displayName?.toString().trim().slice(0, 120) || null;
    return { user: await updateProfile(currentUser(request).id, name) };
  });

  app.post('/api/auth/password', { preHandler: requireUser }, async (request) => {
    const body = request.body as { currentPassword?: string; newPassword?: string };
    if (!body?.currentPassword || !body?.newPassword) {
      throw badRequest('Both currentPassword and newPassword are required.');
    }
    await changePassword(currentUser(request).id, body.currentPassword, body.newPassword);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Two-factor enrolment
  // -------------------------------------------------------------------------

  /**
   * Returns the shared secret plus a QR code. The QR is rendered here rather
   * than in the browser so the secret never has to be handed to a third-party
   * script.
   */
  app.post('/api/auth/2fa/setup', { preHandler: requireUser }, async (request) => {
    const setup = await beginTwoFactorSetup(currentUser(request).id);
    const { toString } = await import('qrcode');
    const qrSvg = await toString(setup.otpauthUri, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f172a', light: '#ffffff' },
    });
    return {
      secret: setup.secret,
      otpauthUri: setup.otpauthUri,
      qrSvg,
      issuer: config.brand.name,
    };
  });

  app.post('/api/auth/2fa/confirm', { preHandler: requireUser }, async (request) => {
    const body = request.body as { code?: string };
    if (!body?.code) throw badRequest('Enter the 6-digit code from your authenticator app.');
    const backupCodes = await confirmTwoFactorSetup(currentUser(request).id, body.code);
    // Shown exactly once — they are not recoverable afterwards.
    return { enabled: true, backupCodes };
  });

  app.post('/api/auth/2fa/disable', { preHandler: requireUser }, async (request) => {
    const body = request.body as { password?: string };
    if (!body?.password) throw badRequest('Confirm your password to turn off two-factor authentication.');
    await disableTwoFactor(currentUser(request).id, body.password);
    return { enabled: false };
  });

  app.post('/api/auth/2fa/backup-codes', { preHandler: requireUser }, async (request) => {
    const body = request.body as { password?: string };
    if (!body?.password) throw badRequest('Confirm your password to generate new recovery codes.');
    const backupCodes = await regenerateBackupCodes(currentUser(request).id, body.password);
    return { backupCodes };
  });

  void isCaptchaEnabled;
}
