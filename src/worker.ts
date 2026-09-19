import { assertRuntimeConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { closeDb } from './db/index.js';
import { logger } from './lib/logger.js';
import { startWorker } from './services/worker.js';

/** Standalone worker process, for deployments that scale workers separately. */
async function main(): Promise<void> {
  assertRuntimeConfig();
  await runMigrations();
  const worker = startWorker();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down worker', { signal });
    await worker.stop();
    await closeDb();
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

main().catch((err) => {
  logger.error('worker failed to start', { error: (err as Error).message });
  process.exit(1);
});
