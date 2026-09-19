import type { FastifyInstance, FastifyRequest } from 'fastify';
import { assertCaptcha } from '../lib/captcha.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { getDb } from '../db/index.js';
import {
  deleteInterest,
  exportCsv,
  interestSchema,
  listInterest,
  markContacted,
  submitInterest,
} from '../services/waitlist.js';
import { currentUser, requireUser } from './plugin.js';

async function requireAdmin(request: FastifyRequest): Promise<string> {
  const session = currentUser(request);
  const db = await getDb();
  const row = await db
    .selectFrom('users')
    .select(['is_admin', 'status'])
    .where('id', '=', session.id)
    .executeTakeFirst();
  if (!row || row.is_admin !== 1 || row.status !== 'active') {
    throw forbidden('Administrator access is required.');
  }
  return session.id;
}

export async function waitlistRoutes(app: FastifyInstance): Promise<void> {
  /** Public. Replaces open registration while the service is invite-only. */
  app.post('/api/interest', async (request) => {
    const parsed = interestSchema.safeParse(request.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw badRequest(first ? `${first.path.join('.')}: ${first.message}` : 'Invalid submission');
    }
    await assertCaptcha(parsed.data.captchaToken, { action: 'interest', ip: request.ip });

    const result = await submitInterest(parsed.data, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    return { ok: true, duplicate: result.duplicate };
  });

  app.get('/api/admin/waitlist', { preHandler: requireUser }, async (request) => {
    await requireAdmin(request);
    const q = request.query as { limit?: string; offset?: string };
    return listInterest({
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
  });

  app.put('/api/admin/waitlist/:id/contacted', { preHandler: requireUser }, async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    const body = request.body as { contacted?: boolean } | undefined;
    await markContacted(Number(id), body?.contacted !== false);
    return { ok: true };
  });

  app.delete('/api/admin/waitlist/:id', { preHandler: requireUser }, async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    await deleteInterest(Number(id));
    return { ok: true };
  });

  app.get('/api/admin/waitlist.csv', { preHandler: requireUser }, async (request, reply) => {
    await requireAdmin(request);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="email-cleaner-waitlist.csv"');
    return exportCsv();
  });
}
