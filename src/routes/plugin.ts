import type { FastifyReply, FastifyRequest } from 'fastify';
import { readSession, SESSION_COOKIE, type SessionUser } from '../auth/index.js';
import { unauthorized } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

/**
 * Reads the session cookie (or a Bearer token, so the API is scriptable) and
 * attaches the user. Routes opt in to requiring one via `requireUser`.
 */
export async function attachUser(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const cookie = (request.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
  const user = await readSession(bearer ?? cookie);
  if (user) request.user = user;
}

export function currentUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw unauthorized();
  return request.user;
}

export async function requireUser(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.user) throw unauthorized();
}
