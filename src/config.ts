import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Minimal .env loader — avoids a dependency and keeps precedence explicit:
 *  real environment variables always win over the .env file. */
function loadDotEnv(file = '.env'): void {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const bool = (v: string | undefined, dflt: boolean): boolean =>
  v === undefined || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v);

const int = (v: string | undefined, dflt: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : dflt;
};

const str = (v: string | undefined): string | undefined => (v && v.length > 0 ? v : undefined);

export type DbConfig =
  | { dialect: 'sqlite'; file: string }
  | { dialect: 'postgres'; connectionString: string };

function parseDatabaseUrl(url: string): DbConfig {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return { dialect: 'postgres', connectionString: url };
  }
  const file = url.startsWith('sqlite:') ? url.slice('sqlite:'.length) : url;
  return { dialect: 'sqlite', file: resolve(process.cwd(), file) };
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  get isProduction() {
    return this.env === 'production';
  },
  port: int(process.env.PORT, 8080),
  /** Bind address. Use 127.0.0.1 when a reverse proxy fronts the service. */
  host: process.env.HOST ?? '0.0.0.0',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, ''),

  encryptionKey: str(process.env.ENCRYPTION_KEY),
  sessionSecret: str(process.env.SESSION_SECRET),

  db: parseDatabaseUrl(process.env.DATABASE_URL ?? 'sqlite:./data/email-cleaner.sqlite'),

  google: {
    clientId: str(process.env.GOOGLE_CLIENT_ID),
    clientSecret: str(process.env.GOOGLE_CLIENT_SECRET),
    /** 'modify' = trash only (sensitive scope). 'full' = permanent delete (restricted scope). */
    scopeLevel: (process.env.GOOGLE_SCOPE_LEVEL === 'full' ? 'full' : 'modify') as 'modify' | 'full',
  },
  microsoft: {
    clientId: str(process.env.MICROSOFT_CLIENT_ID),
    clientSecret: str(process.env.MICROSOFT_CLIENT_SECRET),
    tenant: process.env.MICROSOFT_TENANT ?? 'common',
  },
  yahoo: {
    clientId: str(process.env.YAHOO_CLIENT_ID),
    clientSecret: str(process.env.YAHOO_CLIENT_SECRET),
  },

  limits: {
    maxDeletePerJob: int(process.env.MAX_DELETE_PER_JOB, 25_000),
    maxTrackedItems: int(process.env.MAX_TRACKED_ITEMS, 50_000),
    undoWindowDays: int(process.env.UNDO_WINDOW_DAYS, 30),
  },

  worker: {
    inProcess: bool(process.env.RUN_WORKER_IN_PROCESS, true),
    concurrency: int(process.env.WORKER_CONCURRENCY, 2),
    pollIntervalMs: int(process.env.WORKER_POLL_INTERVAL_MS, 2_000),
  },

  imap: {
    allowInsecureTls: bool(process.env.IMAP_ALLOW_INSECURE_TLS, false),
  },

  allowRegistration: bool(process.env.ALLOW_REGISTRATION, true),

  /** Public identity used in page metadata, legal pages and OAuth consent screens. */
  brand: {
    name: process.env.BRAND_NAME ?? 'Email Cleaner',
    legalEntity: process.env.LEGAL_ENTITY ?? process.env.BRAND_NAME ?? 'Email Cleaner',
    supportEmail: process.env.SUPPORT_EMAIL ?? 'support@emailcleaner.xyz',
    privacyEmail: process.env.PRIVACY_EMAIL ?? process.env.SUPPORT_EMAIL ?? 'privacy@emailcleaner.xyz',
    /** Shown on the legal pages. Google and Microsoft reviewers look for this. */
    postalAddress: process.env.POSTAL_ADDRESS ?? '',
    jurisdiction: process.env.LEGAL_JURISDICTION ?? 'India',
  },

  captcha: {
    /** 'recaptcha' (v3), 'turnstile', or 'none' to disable. */
    provider: (process.env.CAPTCHA_PROVIDER ?? 'none') as 'recaptcha' | 'turnstile' | 'none',
    siteKey: str(process.env.CAPTCHA_SITE_KEY),
    secretKey: str(process.env.CAPTCHA_SECRET_KEY),
    /** reCAPTCHA v3 returns 0.0-1.0; below this the request is treated as a bot. */
    minScore: Number.parseFloat(process.env.CAPTCHA_MIN_SCORE ?? '0.5'),
  },

  auth: {
    /** Require every account to enrol in TOTP before using the app. */
    enforce2fa: bool(process.env.ENFORCE_2FA, false),
    /** Failed logins per identifier before a temporary lockout. */
    maxLoginAttempts: int(process.env.MAX_LOGIN_ATTEMPTS, 8),
    lockoutMinutes: int(process.env.LOGIN_LOCKOUT_MINUTES, 15),
  },

  /** Emitted in robots.txt; set false on staging so it never gets indexed. */
  seo: {
    indexable: bool(process.env.SEO_INDEXABLE, true),
  },

  /**
   * Outbound notification mail. Defaults target a Postfix on the same host,
   * which accepts unauthenticated submission from loopback.
   */
  mail: {
    enabled: bool(process.env.MAIL_ENABLED, true),
    host: process.env.SMTP_HOST ?? '127.0.0.1',
    port: int(process.env.SMTP_PORT, 25),
    from: process.env.MAIL_FROM ?? 'support@emailcleaner.xyz',
    heloName: process.env.MAIL_HELO ?? 'emailcleaner.xyz',
    /** Where interest-form submissions are sent. */
    notifyTo: process.env.NOTIFY_EMAIL ?? 'support@emailcleaner.xyz',
  },
} as const;

export const isCaptchaEnabled = (): boolean =>
  config.captcha.provider !== 'none' && Boolean(config.captcha.siteKey && config.captcha.secretKey);

/** Fail fast on misconfiguration rather than at the first request that needs a secret. */
export function assertRuntimeConfig(): void {
  const problems: string[] = [];
  if (!config.encryptionKey) problems.push('ENCRYPTION_KEY is missing (run: npm run keygen)');
  if (!config.sessionSecret) problems.push('SESSION_SECRET is missing (run: npm run keygen)');
  if (config.isProduction && config.publicBaseUrl.startsWith('http://')) {
    problems.push('PUBLIC_BASE_URL must be https:// in production');
  }
  if (config.isProduction && config.imap.allowInsecureTls) {
    problems.push('IMAP_ALLOW_INSECURE_TLS must be false in production');
  }
  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

export const oauthRedirectUri = (provider: string): string =>
  `${config.publicBaseUrl}/api/oauth/${provider}/callback`;
