import { getDb, nowIso } from '../db/index.js';
import { logger } from '../lib/logger.js';

export interface AuditEntry {
  userId?: string | null;
  accountId?: string | null;
  jobId?: string | null;
  action: string;
  detail?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Deletion is destructive and irreversible in 'permanent' mode, so every
 * mutation gets a row. Failing to write the audit trail must never take down
 * the request that produced it.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    const db = await getDb();
    await db
      .insertInto('audit_log')
      .values({
        user_id: entry.userId ?? null,
        account_id: entry.accountId ?? null,
        job_id: entry.jobId ?? null,
        action: entry.action,
        detail_json: JSON.stringify(entry.detail ?? {}),
        ip: entry.ip ?? null,
        created_at: nowIso(),
      })
      .execute();
  } catch (err) {
    logger.error('audit write failed', { action: entry.action, error: (err as Error).message });
  }
}
