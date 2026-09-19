import { config } from '../config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? (config.isProduction ? 'info' : 'debug')] ?? 20;

/** Secrets leak through logs more often than through code. Redact aggressively. */
const SECRET_KEY = /(password|secret|token|authorization|cookie|refresh_token|access_token|client_secret|appPassword)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const record = { ts: new Date().toISOString(), level, msg, ...(redact(fields ?? {}) as object) };
  const line = config.isProduction
    ? JSON.stringify(record)
    : `${record.ts} ${level.toUpperCase().padEnd(5)} ${msg}${fields ? ' ' + JSON.stringify(redact(fields)) : ''}`;
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bound: Record<string, unknown>): Logger;
}

function make(bound: Record<string, unknown>): Logger {
  const merge = (f?: Record<string, unknown>) =>
    Object.keys(bound).length || f ? { ...bound, ...f } : undefined;
  return {
    debug: (m, f) => emit('debug', m, merge(f)),
    info: (m, f) => emit('info', m, merge(f)),
    warn: (m, f) => emit('warn', m, merge(f)),
    error: (m, f) => emit('error', m, merge(f)),
    child: (extra) => make({ ...bound, ...extra }),
  };
}

export const logger = make({});
