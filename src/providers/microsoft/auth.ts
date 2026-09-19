import { config, oauthRedirectUri } from '../../config.js';
import { buildAuthorizeUrl, type OAuthEndpoints } from '../oauth.js';

export const microsoftEndpoints = (): OAuthEndpoints => ({
  authorizeUrl: `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0/authorize`,
  tokenUrl: `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0/token`,
});

/**
 * Mail.ReadWrite covers both the soft delete (move to Deleted Items) and the
 * permanentDelete action, so Outlook needs no second consent tier the way
 * Gmail does.
 */
export const MICROSOFT_SCOPES = [
  'offline_access',
  'User.Read',
  'https://graph.microsoft.com/Mail.ReadWrite',
];

export const microsoftRedirectUri = (): string => oauthRedirectUri('microsoft');

export function microsoftAuthorizeUrl(state: string, codeChallenge: string): string {
  if (!config.microsoft.clientId) throw new Error('MICROSOFT_CLIENT_ID is not configured');
  return buildAuthorizeUrl(microsoftEndpoints(), {
    client_id: config.microsoft.clientId,
    redirect_uri: microsoftRedirectUri(),
    response_type: 'code',
    response_mode: 'query',
    scope: MICROSOFT_SCOPES.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
    state,
  });
}
