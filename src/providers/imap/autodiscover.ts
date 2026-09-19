import { logger } from '../../lib/logger.js';

export interface ImapServerSettings {
  host: string;
  port: number;
  secure: boolean;
  /** How the user obtains a usable password for this host. */
  guidance?: string;
  source: 'builtin' | 'ispdb' | 'manual';
}

/**
 * Hard-coded settings for the mass-market providers, so the common case needs
 * no network round-trip and keeps working if the ISPDB is unreachable.
 * Anything not listed falls through to Thunderbird's autoconfig database.
 */
const BUILTIN: Record<string, ImapServerSettings> = {
  'yahoo.com': {
    host: 'imap.mail.yahoo.com',
    port: 993,
    secure: true,
    source: 'builtin',
    guidance:
      'Yahoo blocks plain passwords over IMAP. Generate an app password at Yahoo Account Security and paste that instead.',
  },
  'ymail.com': { host: 'imap.mail.yahoo.com', port: 993, secure: true, source: 'builtin' },
  'rocketmail.com': { host: 'imap.mail.yahoo.com', port: 993, secure: true, source: 'builtin' },
  'aol.com': {
    host: 'imap.aol.com',
    port: 993,
    secure: true,
    source: 'builtin',
    guidance: 'AOL requires an app password generated from AOL Account Security.',
  },
  'mail.com': {
    host: 'imap.mail.com',
    port: 993,
    secure: true,
    source: 'builtin',
    guidance:
      'Enable IMAP first: Mail.com > Settings (gear) > POP3 & IMAP > tick "Enable access to this account via POP3 and IMAP", then save.',
  },
  'gmx.com': { host: 'imap.gmx.com', port: 993, secure: true, source: 'builtin', guidance: 'Enable IMAP in GMX Settings > POP3 & IMAP.' },
  'gmx.net': { host: 'imap.gmx.net', port: 993, secure: true, source: 'builtin' },
  'gmx.de': { host: 'imap.gmx.net', port: 993, secure: true, source: 'builtin' },
  'zoho.com': { host: 'imap.zoho.com', port: 993, secure: true, source: 'builtin', guidance: 'Zoho requires an application-specific password when 2FA is on.' },
  'icloud.com': {
    host: 'imap.mail.me.com',
    port: 993,
    secure: true,
    source: 'builtin',
    guidance: 'iCloud always requires an app-specific password from appleid.apple.com > Sign-In and Security.',
  },
  'me.com': { host: 'imap.mail.me.com', port: 993, secure: true, source: 'builtin' },
  'mac.com': { host: 'imap.mail.me.com', port: 993, secure: true, source: 'builtin' },
  'fastmail.com': { host: 'imap.fastmail.com', port: 993, secure: true, source: 'builtin', guidance: 'Create an app password in Fastmail > Settings > Privacy & Security > App Passwords.' },
  'yandex.com': { host: 'imap.yandex.com', port: 993, secure: true, source: 'builtin' },
  'yandex.ru': { host: 'imap.yandex.ru', port: 993, secure: true, source: 'builtin' },
  'protonmail.com': {
    host: '127.0.0.1',
    port: 1143,
    secure: false,
    source: 'builtin',
    guidance:
      'Proton has no public IMAP endpoint. It only works through Proton Mail Bridge running on the same host as this service — self-hosted deployments only.',
  },
  'gmail.com': {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    source: 'builtin',
    guidance:
      'Prefer the Gmail provider (OAuth) over IMAP. If you must use IMAP, the account needs 2-Step Verification plus an App Password.',
  },
  'outlook.com': {
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    source: 'builtin',
    guidance:
      'Prefer the Microsoft provider (OAuth). Microsoft disabled IMAP basic authentication for most accounts, so a plain password will usually be rejected.',
  },
  'hotmail.com': { host: 'outlook.office365.com', port: 993, secure: true, source: 'builtin' },
  'live.com': { host: 'outlook.office365.com', port: 993, secure: true, source: 'builtin' },
};

interface IspdbResult {
  host: string;
  port: number;
  socketType: string;
}

/**
 * Thunderbird's ISPDB covers thousands of domains, which is what makes
 * "any provider" true rather than aspirational.
 */
async function queryIspdb(domain: string, signal?: AbortSignal): Promise<IspdbResult | null> {
  const url = `https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`;
  const response = await fetch(url, { signal: signal ?? null, headers: { accept: 'text/xml' } });
  if (!response.ok) return null;
  const xml = await response.text();

  // A tiny targeted parse beats pulling in an XML dependency for one element.
  const block = /<incomingServer\b[^>]*type="imap"[^>]*>([\s\S]*?)<\/incomingServer>/i.exec(xml);
  if (!block?.[1]) return null;
  const section = block[1];
  const host = /<hostname>\s*([^<\s]+)\s*<\/hostname>/i.exec(section)?.[1];
  const port = /<port>\s*(\d+)\s*<\/port>/i.exec(section)?.[1];
  const socketType = /<socketType>\s*([^<\s]+)\s*<\/socketType>/i.exec(section)?.[1];
  if (!host || !port) return null;
  return { host, port: Number(port), socketType: socketType ?? 'SSL' };
}

/**
 * Resolves IMAP settings for an address. Order: built-in table, then ISPDB,
 * then the conventional imap.<domain>:993 guess, which the connection test
 * will confirm or reject.
 */
export async function discoverImapSettings(
  email: string,
  signal?: AbortSignal,
): Promise<ImapServerSettings> {
  const domain = email.split('@')[1]?.toLowerCase().trim();
  if (!domain) {
    throw new Error(`"${email}" is not a valid email address`);
  }

  const builtin = BUILTIN[domain];
  if (builtin) return builtin;

  try {
    const found = await queryIspdb(domain, signal);
    if (found) {
      return {
        host: found.host,
        port: found.port,
        secure: found.socketType.toUpperCase() === 'SSL' || found.port === 993,
        source: 'ispdb',
      };
    }
  } catch (err) {
    logger.debug('ISPDB lookup failed', { domain, error: (err as Error).message });
  }

  return { host: `imap.${domain}`, port: 993, secure: true, source: 'manual' };
}

export const knownDomains = (): string[] => Object.keys(BUILTIN).sort();
