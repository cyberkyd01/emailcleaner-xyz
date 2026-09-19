import { hostname } from 'node:os';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { sleep } from '../lib/retry.js';
import { newId } from '../lib/ids.js';
import { claimJob, runJob } from './jobs.js';
import { runDueRules } from './rules.js';

export interface WorkerHandle {
  stop(): Promise<void>;
}

/**
 * Database-backed queue rather than Redis: cleaning jobs are low-frequency and
 * long-running, and one less moving part matters more here than throughput.
 * Leases in claimJob() are what make multiple workers safe.
 */
export function startWorker(opts: { concurrency?: number } = {}): WorkerHandle {
  const concurrency = opts.concurrency ?? config.worker.concurrency;
  const workerId = `${hostname()}:${process.pid}:${newId()}`;
  const controller = new AbortController();
  const log = logger.child({ workerId });

  log.info('worker started', { concurrency });

  const loops = Array.from({ length: concurrency }, async (_, slot) => {
    const slotLog = log.child({ slot });
    while (!controller.signal.aborted) {
      let job;
      try {
        job = await claimJob(workerId);
      } catch (err) {
        slotLog.error('claim failed', { error: (err as Error).message });
        await sleep(5_000, controller.signal).catch(() => undefined);
        continue;
      }

      if (!job) {
        await sleep(config.worker.pollIntervalMs, controller.signal).catch(() => undefined);
        continue;
      }

      slotLog.info('running job', { jobId: job.id, status: job.status, mode: job.mode });
      const started = Date.now();
      // runJob records its own failures; anything escaping it is a bug in the
      // recording path, so log and keep the loop alive.
      await runJob(job, controller.signal).catch((err) =>
        slotLog.error('job handler threw', { jobId: job.id, error: (err as Error).message }),
      );
      slotLog.info('job finished', { jobId: job.id, ms: Date.now() - started });
    }
  });

  // Scheduled rules are cheap to check; one tick a minute is plenty.
  const scheduler = (async () => {
    while (!controller.signal.aborted) {
      try {
        const created = await runDueRules();
        if (created > 0) log.info('scheduled rules triggered', { jobs: created });
      } catch (err) {
        log.error('scheduler tick failed', { error: (err as Error).message });
      }
      await sleep(60_000, controller.signal).catch(() => undefined);
    }
  })();

  return {
    async stop() {
      log.info('worker stopping');
      controller.abort();
      await Promise.allSettled([...loops, scheduler]);
      log.info('worker stopped');
    },
  };
}
