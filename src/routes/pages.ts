import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { publicPlans } from '../services/plans.js';
import { providerCatalog } from '../providers/catalog.js';
import { captchaClientConfig } from '../lib/captcha.js';

/**
 * Public pages are plain HTML files served directly, not rendered by the SPA.
 * A crawler must be able to read the marketing and legal content from the
 * initial response — Google's OAuth reviewers check the privacy policy with a
 * plain fetch, and a client-rendered page looks empty to them.
 */
export interface PageDefinition {
  path: string;
  file: string;
  /** Included in sitemap.xml. Private pages are excluded and sent noindex. */
  indexable: boolean;
  changefreq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  priority: number;
}

export const PAGES: readonly PageDefinition[] = [
  { path: '/', file: 'index.html', indexable: true, changefreq: 'weekly', priority: 1.0 },
  { path: '/pricing', file: 'pricing.html', indexable: true, changefreq: 'weekly', priority: 0.9 },
  { path: '/security', file: 'security.html', indexable: true, changefreq: 'monthly', priority: 0.8 },
  { path: '/providers', file: 'providers.html', indexable: true, changefreq: 'monthly', priority: 0.8 },
  { path: '/privacy', file: 'privacy.html', indexable: true, changefreq: 'monthly', priority: 0.7 },
  { path: '/terms', file: 'terms.html', indexable: true, changefreq: 'monthly', priority: 0.7 },
  { path: '/login', file: 'login.html', indexable: false, changefreq: 'monthly', priority: 0.3 },
  { path: '/app', file: 'app.html', indexable: false, changefreq: 'weekly', priority: 0.1 },
  { path: '/admin', file: 'admin.html', indexable: false, changefreq: 'monthly', priority: 0.1 },
] as const;

/** Real file mtime, so lastmod stays honest as pages change. */
function lastModified(webRoot: string, file: string): string {
  try {
    return statSync(join(webRoot, file)).mtime.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export async function pageRoutes(app: FastifyInstance, opts: { webRoot: string }): Promise<void> {
  const { webRoot } = opts;
  const base = config.publicBaseUrl;

  const sendPage = (reply: FastifyReply, page: PageDefinition) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    if (!page.indexable || !config.seo.indexable) {
      reply.header('x-robots-tag', 'noindex, nofollow');
    }
    // Marketing pages are safe to cache briefly at the edge; the app shell is not.
    reply.header(
      'cache-control',
      page.indexable ? 'public, max-age=300, stale-while-revalidate=86400' : 'private, no-store',
    );
    return reply.sendFile(page.file);
  };

  for (const page of PAGES) {
    app.get(page.path, (_request, reply) => sendPage(reply, page));
    // Accept the .html form too, but point crawlers at the canonical path.
    app.get(`/${page.file}`, (_request, reply) => reply.redirect(page.path, 301));
  }

  /**
   * Public runtime configuration for the front-end: plans, provider
   * availability and captcha keys. Served as JS so pages can read it without an
   * extra round trip on first paint.
   */
  app.get('/assets/config.js', async (_request, reply) => {
    const payload = {
      brand: config.brand.name,
      baseUrl: base,
      supportEmail: config.brand.supportEmail,
      registrationOpen: config.allowRegistration,
      captcha: captchaClientConfig(),
      plans: publicPlans(),
      providers: providerCatalog().map((p) => ({
        id: p.id,
        label: p.label,
        description: p.description,
        available: p.available,
        authType: p.authType,
      })),
    };
    reply.header('content-type', 'application/javascript; charset=utf-8');
    reply.header('cache-control', 'public, max-age=60');
    return `window.__EC__=${JSON.stringify(payload)};`;
  });

  app.get('/robots.txt', async (_request, reply) => {
    reply.header('content-type', 'text/plain; charset=utf-8');
    reply.header('cache-control', 'public, max-age=3600');

    if (!config.seo.indexable) {
      return ['User-agent: *', 'Disallow: /', ''].join('\n');
    }

    return [
      'User-agent: *',
      'Allow: /$',
      'Allow: /pricing',
      'Allow: /security',
      'Allow: /providers',
      'Allow: /privacy',
      'Allow: /terms',
      // Nothing behind authentication should ever be crawled or indexed.
      'Disallow: /app',
      'Disallow: /admin',
      'Disallow: /login',
      'Disallow: /api/',
      '',
      `Sitemap: ${base}/sitemap.xml`,
      '',
    ].join('\n');
  });

  app.get('/sitemap.xml', async (_request, reply) => {
    reply.header('content-type', 'application/xml; charset=utf-8');
    reply.header('cache-control', 'public, max-age=3600');

    const urls = PAGES.filter((p) => p.indexable && config.seo.indexable)
      .map((page) => {
        const loc = `${base}${page.path === '/' ? '/' : page.path}`;
        return [
          '  <url>',
          `    <loc>${loc}</loc>`,
          `    <lastmod>${lastModified(webRoot, page.file)}</lastmod>`,
          `    <changefreq>${page.changefreq}</changefreq>`,
          `    <priority>${page.priority.toFixed(1)}</priority>`,
          '  </url>',
        ].join('\n');
      })
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.w3.org/1999/sitemaps/0.9">\n${urls}\n</urlset>\n`.replace(
      'http://www.w3.org/1999/sitemaps/0.9',
      'http://www.sitemaps.org/schemas/sitemap/0.9',
    );
  });

  /** Lets Google and Microsoft reviewers confirm domain ownership quickly. */
  app.get('/.well-known/security.txt', async (_request, reply) => {
    reply.header('content-type', 'text/plain; charset=utf-8');
    const expires = new Date(Date.now() + 365 * 86_400_000).toISOString();
    return [
      `Contact: mailto:${config.brand.supportEmail}`,
      `Expires: ${expires}`,
      'Preferred-Languages: en',
      `Canonical: ${base}/.well-known/security.txt`,
      `Policy: ${base}/security`,
      '',
    ].join('\n');
  });
}
