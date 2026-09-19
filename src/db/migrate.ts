import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { getDb, closeDb, dialect, nowIso, sql } from './index.js';
import { migrations } from './migrations.js';
import { logger } from '../lib/logger.js';

export async function runMigrations(): Promise<void> {
  const db = await getDb();
  await sql`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`.execute(db);

  const applied = new Set(
    (await sql<{ name: string }>`SELECT name FROM _migrations`.execute(db)).rows.map((r) => r.name),
  );

  let count = 0;
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    logger.info('applying migration', { name: migration.name });
    for (const statement of migration.up(dialect())) {
      await sql.raw(statement).execute(db);
    }
    await sql`INSERT INTO _migrations (name, applied_at) VALUES (${migration.name}, ${nowIso()})`.execute(db);
    count++;
  }
  logger.info('migrations up to date', { applied: count, total: migrations.length });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runMigrations()
    .then(closeDb)
    .catch((err) => {
      logger.error('migration failed', { error: (err as Error).message });
      process.exitCode = 1;
    });
}
