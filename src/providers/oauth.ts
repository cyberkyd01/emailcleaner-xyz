import { createHash, randomBytes } from 'node:crypto';
import { AuthExpiredError, ProviderError } from '../lib/errors.js';
import type { ProviderId } from '../db/types.js';

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  /** Epoch millis. */
  expiresAt: number;
  scope?: string | null;
  tokenType?: string;
  idToken?: string | null;
}

export interface OAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkce(): PkcePair {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function postForm(url: string, body: Record<string, string>, provider: ProviderId): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
    });
  } catch (cause) {
    throw new ProviderError({
      provider,
      message: `Could not reach the ${provider} token endpoint`,
      retryable: true,
      details: (cause as Error).message,
    });
  }

  const text = await response.text();
  let json: TokenResponse;
  try {
    json = JSON.parse(text) as TokenResponse;
  } catch {
    throw new ProviderError({
      provider,
      message: `Token endpoint returned a non-JSON response (HTTP ${response.status})`,
      retryable: response.status >= 500,
      details: text.slice(0, 500),
    });
  }

  if (!response.ok || json.error) {
    const description = json.error_description ?? json.error ?? `HTTP ${response.status}`;
    // invalid_grant means the refresh token was revoked, expired, or the user
    // changed their password — reconnecting is the only fix.
    if (json.error === 'invalid_grant' || response.status === 400) {
      throw new AuthExpiredError(provider, `${provider} rejected the credential: ${description}`);
    }
    throw new ProviderError({
      provider,
      message: `Token request failed: ${description}`,
      statusCode: response.status,
      retryable: response.status >= 500 || response.status === 429,
    });
  }

  return json;
}

const toTokenSet = (json: TokenResponse, previous?: TokenSet): TokenSet => {
  if (!json.access_token) throw new Error('Token response contained no access_token');
  return {
    accessToken: json.access_token,
    // Google omits refresh_token on refresh; keep the one we already hold.
    refreshToken: json.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    scope: json.scope ?? previous?.scope ?? null,
    tokenType: json.token_type ?? 'Bearer',
    idToken: json.id_token ?? null,
  };
};

export async function exchangeCode(opts: {
  provider: ProviderId;
  endpoints: OAuthEndpoints;
  clientId: string;
  clientSecret?: string | undefined;
  code: string;
  redirectUri: string;
  codeVerifier?: string | null;
}): Promise<TokenSet> {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
  };
  if (opts.clientSecret) body.client_secret = opts.clientSecret;
  if (opts.codeVerifier) body.code_verifier = opts.codeVerifier;
  return toTokenSet(await postForm(opts.endpoints.tokenUrl, body, opts.provider));
}

export async function refreshTokens(opts: {
  provider: ProviderId;
  endpoints: OAuthEndpoints;
  clientId: string;
  clientSecret?: string | undefined;
  tokens: TokenSet;
  scope?: string | undefined;
}): Promise<TokenSet> {
  if (!opts.tokens.refreshToken) {
    throw new AuthExpiredError(opts.provider, 'No refresh token stored; reconnect the account');
  }
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: opts.tokens.refreshToken,
    client_id: opts.clientId,
  };
  if (opts.clientSecret) body.client_secret = opts.clientSecret;
  if (opts.scope) body.scope = opts.scope;
  return toTokenSet(await postForm(opts.endpoints.tokenUrl, body, opts.provider), opts.tokens);
}

/** Refresh a minute early so a long-running batch does not expire mid-flight. */
export const tokenIsStale = (tokens: TokenSet, skewMs = 60_000): boolean =>
  tokens.expiresAt - skewMs <= Date.now();

export function buildAuthorizeUrl(
  endpoints: OAuthEndpoints,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(endpoints.authorizeUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}
