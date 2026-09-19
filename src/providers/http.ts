import { AuthExpiredError, ProviderError } from '../lib/errors.js';
import type { ProviderId } from '../db/types.js';

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** Expect no response body (204). */
  empty?: boolean;
}

const parseRetryAfter = (header: string | null): number | undefined => {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : undefined;
};

/**
 * One place where every provider HTTP error becomes a typed error, so the job
 * worker can tell "retry in 30s" from "this account needs reconnecting".
 */
export async function apiFetch<T>(
  provider: ProviderId,
  accessToken: string,
  req: ApiRequest,
): Promise<T> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
    ...req.headers,
  };
  let payload: string | undefined;
  if (req.body !== undefined) {
    payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    headers['content-type'] ??= 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(req.url, {
      method: req.method ?? 'GET',
      headers,
      body: payload,
      signal: req.signal ?? null,
    });
  } catch (cause) {
    if ((cause as Error).name === 'AbortError') throw cause;
    throw new ProviderError({
      provider,
      message: `Network error calling ${provider}`,
      retryable: true,
      details: (cause as Error).message,
    });
  }

  if (response.status === 401) {
    throw new AuthExpiredError(provider);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    // 403 from Gmail is usually rateLimitExceeded, not a permission problem —
    // distinguish on the message so we do not disable a healthy account.
    const rateLimited =
      response.status === 429 ||
      response.status === 503 ||
      (response.status === 403 && /rateLimitExceeded|userRateLimitExceeded|backendError/i.test(text));

    // Pull the provider's own reason out of the body so a failed job says
    // which limit was hit rather than just "rate limit".
    let reason = '';
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
      const code = parsed.error?.errors?.[0]?.reason;
      reason = [code, parsed.error?.message].filter(Boolean).join(': ');
    } catch {
      reason = text.slice(0, 200);
    }

    throw new ProviderError({
      provider,
      message: rateLimited
        ? `${provider} rate limit hit${reason ? ` — ${reason}` : ''}`
        : `${provider} request failed (HTTP ${response.status})${reason ? ` — ${reason}` : ''}`,
      statusCode: rateLimited ? 429 : response.status,
      code: rateLimited ? 'rate_limited' : 'provider_error',
      retryable: rateLimited || response.status >= 500,
      retryAfterMs,
      details: text.slice(0, 1000),
    });
  }

  if (req.empty || response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError({
      provider,
      message: `${provider} returned an unparseable response`,
      details: text.slice(0, 500),
    });
  }
}

/** Splits an array into fixed-size chunks — every provider caps batch sizes. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
