import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import { config } from './config.js';
import { AppError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { attachUser } from './routes/plugin.js';
import { authRoutes } from './routes/auth.js';
import { accountRoutes } from './routes/accounts.js';
import { oauthRoutes } from './routes/oauth.js';
import { jobRoutes } from './routes/jobs.js';
import { ruleRoutes } from './routes/rules.js';
import { adminRoutes } from './routes/admin.js';
import { pageRoutes } from './routes/pages.js';
import { waitlistRoutes } from './routes/waitlist.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Content-Security-Policy. The captcha providers need script and frame access,
 * so the policy is built from the configured provider rather than hard-coded
 * to the union of everything.
 */
function contentSecurityPolicy(): string {
  const script = ["'self'"];
  const frame = ["'self'"];
  const connect = ["'self'"];

  if (config.captcha.provider === 'recaptcha') {
    script.push('https://www.google.com', 'https://www.gstatic.com');
    frame.push('https://www.google.com');
  } else if (config.captcha.provider === 'turnstile') {
    script.push('https://challenges.cloudflare.com');
    frame.push('https://challenges.cloudflare.com');
  }

  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    // Inline styles are used for a handful of computed values (progress bars).
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect.join(' ')}`,
    `frame-src ${frame.join(' ')}`,
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    // The app has its own structured logger; Fastify's would double up.
    logger: false,
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  await app.register(cookie, { secret: config.sessionSecret ?? 'unset' });

  const csp = contentSecurityPolicy();

  // Defence in depth for a service that can bulk-delete mail.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('permissions-policy', 'geolocation=(), microphone=(), camera=(), payment=()');
    reply.header('content-security-policy', csp);
    if (config.publicBaseUrl.startsWith('https://')) {
      reply.header('strict-transport-security', 'max-age=15552000; includeSubDomains');
    }
    return payload;
  });

  app.addHook('preHandler', attachUser);

  app.setErrorHandler((error: Error & { validation?: unknown }, request, reply) => {
    if (error instanceof AppError) {
      logger.debug('request rejected', { path: request.url, code: error.code, message: error.message });
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details ?? undefined },
      });
    }
    if ((error as { validation?: unknown }).validation) {
      return reply.code(400).send({ error: { code: 'bad_request', message: error.message } });
    }
    logger.error('unhandled request error', {
      path: request.url,
      method: request.method,
      error: error.message,
      stack: config.isProduction ? undefined : error.stack,
    });
    return reply.code(500).send({
      error: {
        code: 'internal_error',
        // Never leak internals to a client; the log has the detail.
        message: 'Something went wrong handling that request.',
      },
    });
  });

  app.get('/api/health', async () => ({
    ok: true,
    version: 2,
    database: config.db.dialect,
    workerInProcess: config.worker.inProcess,
    time: new Date().toISOString(),
  }));

  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(oauthRoutes);
  await app.register(jobRoutes);
  await app.register(ruleRoutes);
  await app.register(adminRoutes);
  await app.register(waitlistRoutes);

  const webRoot = join(here, 'web');
  // Static assets only; HTML pages are routed explicitly so each one gets the
  // right cache and robots headers. The plugin's own cache-control is disabled
  // because it would otherwise overwrite the per-page values set in pageRoutes.
  await app.register(staticPlugin, {
    root: webRoot,
    prefix: '/',
    index: false,
    cacheControl: false,
    setHeaders(res, path) {
      // Fingerprinting is not in place yet, so assets get a short cache with a
      // long stale window rather than an immutable year.
      if (/\.(css|js|svg|woff2?|png|jpg|webp)$/.test(path)) {
        res.setHeader('cache-control', 'public, max-age=3600, stale-while-revalidate=86400');
      }
    },
  });
  await app.register(pageRoutes, { webRoot });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such endpoint' } });
    }
    reply.code(404).header('content-type', 'text/html; charset=utf-8');
    return reply.sendFile('404.html');
  });

  return app;
}
