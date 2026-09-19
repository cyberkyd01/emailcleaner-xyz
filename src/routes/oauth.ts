import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getDb, isoIn, nowIso } from '../db/index.js';
import { randomToken } from '../lib/ids.js';
import { badRequest, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { createPkce, exchangeCode } from '../providers/oauth.js';
import { GMAIL_ENDPOINTS, gmailAuthorizeUrl, gmailRedirectUri, gmailScopes } from '../providers/gmail/auth.js';
import { microsoftAuthorizeUrl, microsoftEndpoints, microsoftRedirectUri } from '../providers/microsoft/auth.js';
import { GmailProvider } from '../providers/gmail/adapter.js';
import { MicrosoftProvider } from '../providers/microsoft/adapter.js';
import { upsertAccount } from '../services/accounts.js';
import { assertCanAddMailbox } from '../services/plans.js';
import { currentUser, requireUser } from './plugin.js';
import type { ProviderId } from '../db/types.js';

const STATE_TTL_MS = 10 * 60_000;

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** Closes the popup and tells the opener how it went. */
const closingPage = (payload: Record<string, unknown>): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>Connecting…</title></head>
<body style="font-family:system-ui;padding:2rem">
<p>${escapeHtml(String(payload.error ?? 'Account connected. You can close this window.'))}</p>
<script>
  try { window.opener && window.opener.postMessage(${JSON.stringify(payload)}, window.location.origin); } catch (e) {}
  setTimeout(function () { window.close(); }, 600);
</script>
</body></html>`;

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  /** Starts a connect flow and returns the URL the browser should open. */
  app.post('/api/oauth/:provider/start', { preHandler: requireUser }, async (request) => {
    const user = currentUser(request);
    const provider = (request.params as { provider: string }).provider as ProviderId;

    if (provider === 'gmail' && !(config.google.clientId && config.google.clientSecret)) {
      throw badRequest('Gmail is not configured on this server. See docs/providers/gmail.md.');
    }
    if (provider === 'microsoft' && !(config.microsoft.clientId && config.microsoft.clientSecret)) {
      throw badRequest('Microsoft is not configured on this server. See docs/providers/microsoft.md.');
    }
    if (provider !== 'gmail' && provider !== 'microsoft') {
      throw badRequest(`"${provider}" does not use OAuth. Use POST /api/accounts/imap instead.`);
    }

    // Check the quota before sending the user through a consent screen that
    // would only fail on the way back.
    await assertCanAddMailbox(user.id);

    const state = randomToken(32);
    // Microsoft gets PKCE; Google web clients authenticate with the secret.
    const pkce = provider === 'microsoft' ? createPkce() : null;

    const db = await getDb();
    await db
      .insertInto('oauth_states')
      .values({
        state,
        user_id: user.id,
        provider,
        code_verifier: pkce?.verifier ?? null,
        account_id: null,
        redirect_to: null,
        created_at: nowIso(),
        expires_at: isoIn(STATE_TTL_MS),
      })
      .execute();

    const url =
      provider === 'gmail'
        ? gmailAuthorizeUrl(state)
        : microsoftAuthorizeUrl(state, (pkce as { challenge: string }).challenge);

    return { url, state, expiresInSeconds: STATE_TTL_MS / 1000 };
  });

  /** The provider redirects here. No session cookie is required — state is the proof. */
  app.get('/api/oauth/:provider/callback', async (request, reply) => {
    const provider = (request.params as { provider: string }).provider as ProviderId;
    const query = request.query as { code?: string; state?: string; error?: string; error_description?: string };
    reply.type('text/html');

    if (query.error) {
      return closingPage({
        type: 'oauth',
        ok: false,
        error: `${provider} returned "${query.error}": ${query.error_description ?? 'no detail given'}`,
      });
    }
    if (!query.code || !query.state) {
      return closingPage({ type: 'oauth', ok: false, error: 'The callback was missing its code or state.' });
    }

    const db = await getDb();
    const row = await db
      .selectFrom('oauth_states')
      .selectAll()
      .where('state', '=', query.state)
      .executeTakeFirst();
    // Single-use: consume the state whatever happens next.
    if (row) await db.deleteFrom('oauth_states').where('state', '=', query.state).execute();

    if (!row || row.provider !== provider) {
      return closingPage({ type: 'oauth', ok: false, error: 'This sign-in link is not valid for this server.' });
    }
    if (new Date(row.expires_at) < new Date()) {
      return closingPage({ type: 'oauth', ok: false, error: 'The sign-in took too long. Please try again.' });
    }

    try {
      const tokens =
        provider === 'gmail'
          ? await exchangeCode({
              provider: 'gmail',
              endpoints: GMAIL_ENDPOINTS,
              clientId: config.google.clientId as string,
              clientSecret: config.google.clientSecret,
              code: query.code,
              redirectUri: gmailRedirectUri(),
            })
          : await exchangeCode({
              provider: 'microsoft',
              endpoints: microsoftEndpoints(),
              clientId: config.microsoft.clientId as string,
              clientSecret: config.microsoft.clientSecret,
              code: query.code,
              redirectUri: microsoftRedirectUri(),
              codeVerifier: row.code_verifier,
            });

      // Google only returns a refresh token on the first consent. Without one
      // the account breaks in an hour, so refuse it now with a clear reason.
      if (!tokens.refreshToken) {
        return closingPage({
          type: 'oauth',
          ok: false,
          error:
            'No refresh token was issued, so this connection would expire within the hour. Remove this app from your account security settings and connect again.',
        });
      }

      const probe =
        provider === 'gmail' ? new GmailProvider('probe', tokens) : new MicrosoftProvider('probe', tokens);
      const identity = await probe.verify();
      await probe.close();

      if (!identity.email) {
        return closingPage({ type: 'oauth', ok: false, error: 'Could not read the mailbox address from the provider.' });
      }

      const account = await upsertAccount({
        userId: row.user_id,
        provider,
        authType: 'oauth2',
        email: identity.email.toLowerCase(),
        displayName: identity.displayName ?? null,
        secret: { kind: 'oauth2', tokens },
        scopes: tokens.scope ?? (provider === 'gmail' ? gmailScopes().join(' ') : null),
        settings: { scopeLevel: provider === 'gmail' ? config.google.scopeLevel : undefined },
      });

      return closingPage({ type: 'oauth', ok: true, accountId: account.id, email: account.email, provider });
    } catch (err) {
      logger.error('oauth callback failed', { provider, error: (err as Error).message });
      return closingPage({ type: 'oauth', ok: false, error: (err as Error).message });
    }
  });

  /** Housekeeping endpoint for deployments without a cron: drops stale states. */
  app.post('/api/oauth/cleanup', { preHandler: requireUser }, async (request) => {
    if (!currentUser(request).isAdmin) throw notFound('Route');
    const db = await getDb();
    const result = await db.deleteFrom('oauth_states').where('expires_at', '<', nowIso()).executeTakeFirst();
    return { removed: Number(result.numDeletedRows ?? 0) };
  });
}
