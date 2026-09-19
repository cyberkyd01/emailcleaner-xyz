import { config, isCaptchaEnabled } from '../config.js';
import { logger } from './logger.js';
import { badRequest } from './errors.js';

/**
 * Bot protection for the unauthenticated endpoints. Supports Google reCAPTCHA
 * v3 (score-based, invisible) and Cloudflare Turnstile, because the two share
 * the same verify-token-server-side shape and deployments differ on which is
 * acceptable in their jurisdiction.
 *
 * When no provider is configured the checks are skipped, so a local or
 * self-hosted deployment works without signing up for anything.
 */

interface VerifyResponse {
  success: boolean;
  score?: number;
  action?: string;
  hostname?: string;
  'error-codes'?: string[];
}

const ENDPOINTS: Record<string, string> = {
  recaptcha: 'https://www.google.com/recaptcha/api/siteverify',
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
};

export interface CaptchaResult {
  ok: boolean;
  skipped: boolean;
  score?: number;
  reason?: string;
}

export async function verifyCaptcha(
  token: string | undefined,
  opts: { action?: string; ip?: string | undefined } = {},
): Promise<CaptchaResult> {
  if (!isCaptchaEnabled()) return { ok: true, skipped: true };
  if (!token) return { ok: false, skipped: false, reason: 'missing_token' };

  const endpoint = ENDPOINTS[config.captcha.provider];
  if (!endpoint) return { ok: true, skipped: true };

  const body = new URLSearchParams({
    secret: config.captcha.secretKey as string,
    response: token,
  });
  if (opts.ip) body.set('remoteip', opts.ip);

  let json: VerifyResponse;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(8000),
    });
    json = (await response.json()) as VerifyResponse;
  } catch (err) {
    // A captcha outage must not lock every user out of their own mailboxes.
    // Fail open, but log it loudly so the gap is visible.
    logger.error('captcha verification unreachable, allowing request', {
      provider: config.captcha.provider,
      error: (err as Error).message,
    });
    return { ok: true, skipped: true, reason: 'verifier_unreachable' };
  }

  if (!json.success) {
    return { ok: false, skipped: false, reason: (json['error-codes'] ?? ['rejected']).join(',') };
  }

  // Turnstile has no score; reCAPTCHA v3 does.
  if (typeof json.score === 'number' && json.score < config.captcha.minScore) {
    return { ok: false, skipped: false, score: json.score, reason: 'low_score' };
  }

  // A mismatched action means the token was minted for a different form and
  // replayed here.
  if (opts.action && json.action && json.action !== opts.action) {
    return { ok: false, skipped: false, reason: 'action_mismatch' };
  }

  return { ok: true, skipped: false, score: json.score };
}

/** Throws the standard 400 when a captcha is required and fails. */
export async function assertCaptcha(
  token: string | undefined,
  opts: { action: string; ip?: string | undefined },
): Promise<void> {
  const result = await verifyCaptcha(token, opts);
  if (result.ok) return;
  logger.warn('captcha rejected', { action: opts.action, reason: result.reason, score: result.score });
  throw badRequest(
    result.reason === 'missing_token'
      ? 'Captcha verification is required. Reload the page and try again.'
      : 'Captcha verification failed. Reload the page and try again.',
  );
}

/** Public config the browser needs to render the widget. */
export const captchaClientConfig = () => ({
  provider: isCaptchaEnabled() ? config.captcha.provider : 'none',
  siteKey: isCaptchaEnabled() ? config.captcha.siteKey : null,
});
