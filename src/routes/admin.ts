import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { forbidden, badRequest } from '../lib/errors.js';
import { getDb } from '../db/index.js';
import {
  deleteUser,
  listUsers,
  overview,
  resetUserTwoFactor,
  setUserPlan,
  setUserStatus,
  userDetail,
} from '../services/admin.js';
import { publicPlans } from '../services/plans.js';
import { currentUser, requireUser } from './plugin.js';
import type { PlanId } from '../db/types.js';

/**
 * The session JWT carries an `admin` claim, but it is only a hint: a user could
 * have been demoted after the token was issued. Every admin route re-reads the
 * flag from the database.
 */
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

const planSchema = z.object({ plan: z.enum(['free', 'pro', 'business']) });
const statusSchema = z.object({ status: z.enum(['active', 'suspended']) });

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/overview', { preHandler: requireUser }, async (request) => {
    await requireAdmin(request);
    return { overview: await overview(), plans: publicPlans() };
  });

  app.get('/api/admin/users', { preHandler: requireUser }, async (request) => {
    await requireAdmin(request);
    const q = request.query as {
      search?: string;
      plan?: string;
      status?: string;
      limit?: string;
      offset?: string;
    };
    const { users, total } = await listUsers({
      search: q.search,
      plan: q.plan,
      status: q.status,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
    return { users, total };
  });

  app.get('/api/admin/users/:id', { preHandler: requireUser }, async (request) => {
    await requireAdmin(request);
    const { id } = request.params as { id: string };
    return await userDetail(id);
  });

  app.put('/api/admin/users/:id/plan', { preHandler: requireUser }, async (request) => {
    const adminId = await requireAdmin(request);
    const { id } = request.params as { id: string };
    const parsed = planSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('plan must be one of: free, pro, business');
    await setUserPlan(adminId, id, parsed.data.plan as PlanId);
    return { ok: true };
  });

  app.put('/api/admin/users/:id/status', { preHandler: requireUser }, async (request) => {
    const adminId = await requireAdmin(request);
    const { id } = request.params as { id: string };
    const parsed = statusSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('status must be active or suspended');
    if (id === adminId) throw badRequest('You cannot change your own status.');
    await setUserStatus(adminId, id, parsed.data.status);
    return { ok: true };
  });

  app.post('/api/admin/users/:id/reset-2fa', { preHandler: requireUser }, async (request) => {
    const adminId = await requireAdmin(request);
    const { id } = request.params as { id: string };
    await resetUserTwoFactor(adminId, id);
    return { ok: true };
  });

  app.delete('/api/admin/users/:id', { preHandler: requireUser }, async (request) => {
    const adminId = await requireAdmin(request);
    const { id } = request.params as { id: string };
    if (id === adminId) throw badRequest('You cannot delete your own account here.');
    await deleteUser(adminId, id);
    return { ok: true };
  });

  /** Recent platform-wide audit entries. Metadata only — never message content. */
  app.get('/api/admin/audit', { preHandler: requireUser }, async (request) => {
    await requireAdmin(request);
    const q = request.query as { limit?: string; action?: string };
    const db = await getDb();
    let query = db
      .selectFrom('audit_log')
      .leftJoin('users', 'users.id', 'audit_log.user_id')
      .select([
        'audit_log.id as id',
        'audit_log.action as action',
        'audit_log.created_at as created_at',
        'audit_log.ip as ip',
        'audit_log.detail_json as detail_json',
        'users.email as email',
      ]);
    if (q.action) query = query.where('audit_log.action', 'like', `${q.action}%`);
    const rows = await query
      .orderBy('audit_log.id', 'desc')
      .limit(Math.min(q.limit ? Number(q.limit) : 100, 500))
      .execute();

    return {
      entries: rows.map((r) => ({
        id: Number(r.id),
        action: r.action,
        email: r.email,
        ip: r.ip,
        createdAt: r.created_at,
        detail: safeParse(r.detail_json),
      })),
    };
  });
}

const safeParse = (json: string): Record<string, unknown> => {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
};
