/** Errors that are safe to render to an API client verbatim. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new AppError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Authentication required') =>
  new AppError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Not allowed') => new AppError(403, 'forbidden', msg);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (msg: string, details?: unknown) =>
  new AppError(409, 'conflict', msg, details);
export const tooManyRequests = (msg: string, retryAfterSec?: number) =>
  new AppError(429, 'rate_limited', msg, { retryAfterSec });

/** A provider rejected us. `retryable` drives the job worker's backoff decision. */
export class ProviderError extends AppError {
  readonly provider: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(opts: {
    provider: string;
    message: string;
    statusCode?: number;
    code?: string;
    retryable?: boolean;
    retryAfterMs?: number;
    details?: unknown;
  }) {
    super(opts.statusCode ?? 502, opts.code ?? 'provider_error', opts.message, opts.details);
    this.name = 'ProviderError';
    this.provider = opts.provider;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** The stored credential no longer works — the account needs reconnecting. */
export class AuthExpiredError extends ProviderError {
  constructor(provider: string, message = 'Credentials expired or revoked; reconnect the account') {
    super({ provider, message, statusCode: 401, code: 'auth_expired', retryable: false });
    this.name = 'AuthExpiredError';
  }
}
