import { ProviderError } from './errors.js';
import { logger } from './logger.js';

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
  signal?: AbortSignal;
}

const isRetryable = (err: unknown): boolean => {
  if (err instanceof ProviderError) return err.retryable;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE' || code === 'ECONNREFUSED';
};

/** Retries transient provider failures with exponential backoff + jitter,
 *  honouring a server-supplied Retry-After when present. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 30_000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryable(err)) throw err;
      // A server-supplied Retry-After is authoritative: honour it even when it
      // exceeds our own ceiling, because ignoring it just earns another 429.
      const serverHint = err instanceof ProviderError ? err.retryAfterMs : undefined;
      const backoff = Math.min(max, base * 2 ** (attempt - 1));
      const delay = serverHint ?? Math.round(backoff * (0.5 + Math.random() * 0.5));
      logger.warn('retrying after provider error', {
        label: opts.label,
        attempt,
        attempts,
        delayMs: delay,
        error: (err as Error).message,
      });
      await sleep(delay, opts.signal);
    }
  }
  throw lastError;
}

/**
 * Token bucket. Providers publish per-user quotas (Gmail counts "quota units",
 * Graph throttles per mailbox); spending steadily beats getting 429'd.
 */
export class TokenBucket {
  #tokens: number;
  #lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.#tokens = capacity;
  }

  async take(cost = 1, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.#tokens = Math.min(this.capacity, this.#tokens + ((now - this.#lastRefill) / 1000) * this.refillPerSecond);
      this.#lastRefill = now;
      if (this.#tokens >= cost) {
        this.#tokens -= cost;
        return;
      }
      const deficit = cost - this.#tokens;
      await sleep(Math.max(50, Math.ceil((deficit / this.refillPerSecond) * 1000)), signal);
    }
  }
}

/** Runs tasks with bounded concurrency, preserving input order in the result. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}
