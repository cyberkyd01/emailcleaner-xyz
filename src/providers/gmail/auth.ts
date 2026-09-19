import { config, oauthRedirectUri } from '../../config.js';
import { buildAuthorizeUrl, type OAuthEndpoints } from '../oauth.js';

export const GMAIL_ENDPOINTS: OAuthEndpoints = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
};

/** Trash-only. Sensitive scope: Google verification, no CASA security assessment. */
export const SCOPE_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
/** Permanent delete (messages.batchDelete). Restricted scope: annual CASA audit. */
export const SCOPE_FULL = 'https://mail.google.com/';
export const SCOPE_EMAIL = 'https://www.googleapis.com/auth/userinfo.email';

export const gmailScopes = (): string[] => [
  config.google.scopeLevel === 'full' ? SCOPE_FULL : SCOPE_MODIFY,
  SCOPE_EMAIL,
];

export const grantsPermanentDelete = (scope: string | null | undefined): boolean =>
  (scope ?? '').split(/\s+/).includes(SCOPE_FULL);

export const gmailRedirectUri = (): string => oauthRedirectUri('gmail');

export function gmailAuthorizeUrl(state: string): string {
  if (!config.google.clientId) throw new Error('GOOGLE_CLIENT_ID is not configured');
  return buildAuthorizeUrl(GMAIL_ENDPOINTS, {
    client_id: config.google.clientId,
    redirect_uri: gmailRedirectUri(),
    response_type: 'code',
    scope: gmailScopes().join(' '),
    // offline + consent is what actually returns a refresh token on re-auth.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
}
