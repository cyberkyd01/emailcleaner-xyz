import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import type { Database } from './types.js';

let instance: Kysely<Database> | null = null;
let closeUnderlying: (() => Promise<void>) | null = null;

async function createSqlite(file: string): Promise<Kysely<Database>> {
  const { default: SQLite } = await import('better-sqlite3');
  mkdirSync(dirname(file), { recursive: true });
  const sqlite = new SQLite(file);
  // WAL lets the API process read while the worker writes.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 10000');
  closeUnderlying = async () => {
    sqlite.close();
  };
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
}

async function createPostgres(connectionString: string): Promise<Kysely<Database>> {
  const pg = await import('pg');
  // Without this, BIGINT columns arrive as strings and silently break arithmetic.
  pg.default.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10));
  const pool = new pg.default.Pool({ connectionString, max: 10 });
  closeUnderlying = async () => {
    await pool.end();
  };
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export async function getDb(): Promise<Kysely<Database>> {
  if (instance) return instance;
  instance =
    config.db.dialect === 'sqlite'
      ? await createSqlite(config.db.file)
      : await createPostgres(config.db.connectionString);
  logger.info('database connected', { dialect: config.db.dialect });
  return instance;
}

export async function closeDb(): Promise<void> {
  if (!instance) return;
  await instance.destroy();
  await closeUnderlying?.();
  instance = null;
  closeUnderlying = null;
}

export const dialect = (): 'sqlite' | 'postgres' => config.db.dialect;

export const nowIso = (): string => new Date().toISOString();

export const isoIn = (ms: number): string => new Date(Date.now() + ms).toISOString();

export { sql };
export type { Database };
