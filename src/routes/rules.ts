import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { createRule, deleteRule, getRule, listRules, runRuleNow, updateRule } from '../services/rules.js';
import { getJob } from '../services/jobs.js';
import { currentUser, requireUser } from './plugin.js';

const ruleSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  query: z.unknown(),
  mode: z.enum(['trash', 'permanent']).default('trash'),
  enabled: z.boolean().default(true),
  /** 5-field cron, evaluated in UTC. Null means manual only. */
  scheduleCron: z.string().trim().min(1).max(120).nullable().default(null),
  autoConfirm: z.boolean().default(false),
});

export async function ruleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/rules', { preHandler: requireUser }, async (request) => {
    const q = request.query as { accountId?: string };
    return { rules: await listRules(currentUser(request).id, q.accountId) };
  });

  app.post('/api/rules', { preHandler: requireUser }, async (request, reply) => {
    const parsed = ruleSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid rule', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    reply.code(201);
    const { query, ...rest } = parsed.data;
    return { rule: await createRule({ userId: currentUser(request).id, query, ...rest }) };
  });

  app.get('/api/rules/:id', { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    return { rule: await getRule(currentUser(request).id, id) };
  });

  app.patch('/api/rules/:id', { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    const patch = ruleSchema.partial().omit({ accountId: true }).safeParse(request.body ?? {});
    if (!patch.success) throw badRequest('Invalid rule patch');
    return { rule: await updateRule(currentUser(request).id, id, patch.data) };
  });

  app.delete('/api/rules/:id', { preHandler: requireUser }, async (request) => {
    const { id } = request.params as { id: string };
    await deleteRule(currentUser(request).id, id);
    return { ok: true };
  });

  /** Queues the rule immediately. It still previews and waits for confirmation. */
  app.post('/api/rules/:id/run', { preHandler: requireUser }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = currentUser(request).id;
    const jobId = await runRuleNow(userId, id);
    reply.code(202);
    return { job: await getJob(userId, jobId) };
  });
}
