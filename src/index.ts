import { assertRuntimeConfig, config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { closeDb } from './db/index.js';
import { logger } from './lib/logger.js';
import { buildServer } from './server.js';
import { startWorker, type WorkerHandle } from './services/worker.js';

async function main(): Promise<void> {
  assertRuntimeConfig();
  await runMigrations();

  const app = await buildServer();
  // Running the worker in-process keeps single-container deploys to one service;
  // set RUN_WORKER_IN_PROCESS=false to scale it out separately.
  const worker: WorkerHandle | null = config.worker.inProcess ? startWorker() : null;

  await app.listen({ port: config.port, host: config.host });
  logger.info('email-cleaner listening', {
    url: config.publicBaseUrl,
    bind: `${config.host}:${config.port}`,
    port: config.port,
    env: config.env,
    worker: config.worker.inProcess ? 'in-process' : 'external',
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    // Stop accepting requests first, then let in-flight jobs unwind.
    await app.close().catch((err) => logger.error('http close failed', { error: (err as Error).message }));
    await worker?.stop().catch((err) => logger.error('worker stop failed', { error: (err as Error).message }));
    await closeDb();
    process.exit(0);
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

main().catch((err) => {
  logger.error('failed to start', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
