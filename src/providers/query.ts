import { z } from 'zod';
import {
  FOLDER_ROLES,
  PROTECTED_ROLES,
  type CleanQuery,
  type FolderRole,
  type KeywordScope,
  type MessageRef,
  type NormalizedFolder,
  type ResidualFilter,
} from './types.js';
import { badRequest } from '../lib/errors.js';

const trimmedList = (max: number) =>
  z
    .array(z.string().trim().min(1).max(200))
    .max(max)
    .default([])
    .transform((v) => [...new Set(v)]);

const folderSelector = z
  .string()
  .trim()
  .min(1)
  .refine(
    (v) => v.startsWith('folder:') || (FOLDER_ROLES as readonly string[]).includes(v),
    (v) => ({ message: `Unknown folder selector "${v}" — use a role name or folder:REMOTE_ID` }),
  );

export const cleanQuerySchema = z
  .object({
    folders: z.array(folderSelector).max(100).default([]),
    keywords: trimmedList(50),
    keywordMatch: z.enum(['any', 'all']).default('any'),
    keywordScope: z.enum(['anywhere', 'subject', 'from', 'subject_or_from']).default('anywhere'),
    from: trimmedList(50),
    to: trimmedList(50),
    olderThanDays: z.number().int().min(0).max(36_500).optional(),
    newerThanDays: z.number().int().min(0).max(36_500).optional(),
    before: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
    after: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
    largerThanBytes: z.number().int().min(0).optional(),
    smallerThanBytes: z.number().int().min(0).optional(),
    readState: z.enum(['any', 'read', 'unread']).default('any'),
    hasAttachment: z.boolean().optional(),
    excludeStarred: z.boolean().default(true),
    excludeImportant: z.boolean().default(true),
    excludeKeywords: trimmedList(50),
    excludeFrom: trimmedList(50),
    limit: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    const hasSelector =
      q.folders.length > 0 ||
      q.keywords.length > 0 ||
      q.from.length > 0 ||
      q.to.length > 0 ||
      q.olderThanDays !== undefined ||
      q.before !== undefined ||
      q.after !== undefined ||
      q.largerThanBytes !== undefined ||
      q.readState !== 'any' ||
      q.hasAttachment !== undefined;
    if (!hasSelector) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Query is unbounded — it would match every message. Name at least one folder, keyword, sender or date filter.',
      });
    }
    if (q.olderThanDays !== undefined && q.newerThanDays !== undefined && q.newerThanDays >= q.olderThanDays) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'newerThanDays must be smaller than olderThanDays' });
    }
    if (q.largerThanBytes !== undefined && q.smallerThanBytes !== undefined && q.smallerThanBytes <= q.largerThanBytes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'smallerThanBytes must exceed largerThanBytes' });
    }
  });

export function parseCleanQuery(input: unknown): CleanQuery {
  const result = cleanQuerySchema.safeParse(input ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    // Lead with the first problem: an API client that only surfaces `message`
    // should still learn what is actually wrong.
    const first = issues[0];
    const summary = first ? `${first.path ? `${first.path}: ` : ''}${first.message}` : 'Invalid query';
    throw badRequest(issues.length > 1 ? `${summary} (+${issues.length - 1} more)` : summary, issues);
  }
  return result.data as CleanQuery;
}

// ---------------------------------------------------------------------------
// Date resolution
// ---------------------------------------------------------------------------

export interface DateWindow {
  /** Delete messages sent strictly before this instant. */
  before?: Date;
  /** Delete messages sent on or after this instant. */
  after?: Date;
}

/** Collapses relative (olderThanDays) and absolute (before/after) bounds into one window. */
export function resolveDateWindow(q: CleanQuery, now = new Date()): DateWindow {
  const window: DateWindow = {};
  const day = 86_400_000;

  if (q.olderThanDays !== undefined) window.before = new Date(now.getTime() - q.olderThanDays * day);
  if (q.newerThanDays !== undefined) window.after = new Date(now.getTime() - q.newerThanDays * day);

  if (q.before) {
    const abs = new Date(q.before.length === 10 ? `${q.before}T00:00:00.000Z` : q.before);
    if (!window.before || abs < window.before) window.before = abs;
  }
  if (q.after) {
    const abs = new Date(q.after.length === 10 ? `${q.after}T00:00:00.000Z` : q.after);
    if (!window.after || abs > window.after) window.after = abs;
  }
  return window;
}

// ---------------------------------------------------------------------------
// Folder resolution
// ---------------------------------------------------------------------------

export interface FolderResolution {
  selected: NormalizedFolder[];
  /** Selectors that matched nothing on this account — surfaced, not silently dropped. */
  unmatched: string[];
  /** Protected folders the user explicitly named. */
  protectedIncluded: NormalizedFolder[];
}

/**
 * Maps role/id selectors onto this account's real folders.
 *
 * An empty selector list means "every folder this account exposes that is not
 * protected" — the default that makes a bare keyword search do the right thing.
 */
export function resolveFolders(selectors: readonly string[], folders: readonly NormalizedFolder[]): FolderResolution {
  if (selectors.length === 0) {
    return { selected: folders.filter((f) => !f.isProtected), unmatched: [], protectedIncluded: [] };
  }

  const byRemoteId = new Map(folders.map((f) => [f.remoteId, f]));
  const selected = new Map<string, NormalizedFolder>();
  const unmatched: string[] = [];

  for (const selector of selectors) {
    if (selector.startsWith('folder:')) {
      const folder = byRemoteId.get(selector.slice('folder:'.length));
      if (folder) selected.set(folder.remoteId, folder);
      else unmatched.push(selector);
      continue;
    }
    const role = selector as FolderRole;
    const matches = folders.filter((f) => f.role === role);
    if (matches.length === 0) unmatched.push(selector);
    for (const folder of matches) selected.set(folder.remoteId, folder);
  }

  const list = [...selected.values()];
  return {
    selected: list,
    unmatched,
    protectedIncluded: list.filter((f) => f.isProtected || PROTECTED_ROLES.has(f.role)),
  };
}

// ---------------------------------------------------------------------------
// Residual filtering (the client-side safety net)
// ---------------------------------------------------------------------------

const norm = (s: string | null | undefined): string => (s ?? '').toLowerCase();

const scopeText = (ref: MessageRef, scope: KeywordScope): string => {
  switch (scope) {
    case 'subject':
      return norm(ref.subject);
    case 'from':
      return norm(ref.from);
    case 'subject_or_from':
      return `${norm(ref.subject)} ${norm(ref.from)}`;
    default:
      return `${norm(ref.subject)} ${norm(ref.from)} ${norm(ref.to)} ${norm(ref.bodyText)}`;
  }
};

/** Substring match on an address/domain fragment, so "@ads.example.com" works. */
const addressMatches = (value: string | null | undefined, needles: readonly string[]): boolean => {
  const v = norm(value);
  return needles.some((n) => v.includes(n.toLowerCase()));
};

/**
 * Returns true when the message should still be deleted after applying every
 * filter the provider could not enforce. Anything uncertain returns false:
 * a message that cannot be proven to match is never deleted.
 */
export function matchesResidual(ref: MessageRef, residual: ResidualFilter): boolean {
  if (residual.excludeStarred && ref.isStarred === true) return false;

  if (residual.keywords && residual.keywords.terms.length > 0) {
    const haystack = scopeText(ref, residual.keywords.scope);
    const hits = residual.keywords.terms.map((t) => haystack.includes(t.toLowerCase()));
    const ok = residual.keywords.match === 'all' ? hits.every(Boolean) : hits.some(Boolean);
    if (!ok) return false;
  }

  if (residual.excludeKeywords && residual.excludeKeywords.length > 0) {
    const haystack = scopeText(ref, 'anywhere');
    if (residual.excludeKeywords.some((t) => haystack.includes(t.toLowerCase()))) return false;
  }

  if (residual.from && residual.from.length > 0 && !addressMatches(ref.from, residual.from)) return false;
  if (residual.excludeFrom && residual.excludeFrom.length > 0 && addressMatches(ref.from, residual.excludeFrom)) return false;
  if (residual.to && residual.to.length > 0 && !addressMatches(ref.to, residual.to)) return false;

  if (residual.sentBefore || residual.sentAfter) {
    // No date on the message means we cannot prove it is in range — keep it.
    if (!ref.sentAt) return false;
    const sent = new Date(ref.sentAt).getTime();
    if (!Number.isFinite(sent)) return false;
    if (residual.sentBefore && sent >= new Date(residual.sentBefore).getTime()) return false;
    if (residual.sentAfter && sent < new Date(residual.sentAfter).getTime()) return false;
  }

  if (residual.minBytes !== undefined) {
    if (ref.sizeBytes == null || ref.sizeBytes <= residual.minBytes) return false;
  }
  if (residual.maxBytes !== undefined) {
    if (ref.sizeBytes == null || ref.sizeBytes >= residual.maxBytes) return false;
  }

  if (residual.readState && residual.readState !== 'any') {
    if (ref.isUnread === undefined) return false;
    if (residual.readState === 'unread' && !ref.isUnread) return false;
    if (residual.readState === 'read' && ref.isUnread) return false;
  }

  if (residual.hasAttachment !== undefined) {
    if (ref.hasAttachment === undefined) return false;
    if (ref.hasAttachment !== residual.hasAttachment) return false;
  }

  return true;
}

export const residualIsEmpty = (r: ResidualFilter): boolean =>
  Object.values(r).every((v) => v === undefined || v === false || (Array.isArray(v) && v.length === 0));

// ---------------------------------------------------------------------------
// Human-readable summary (shown in previews, audit log and the UI)
// ---------------------------------------------------------------------------

export function describeQuery(q: CleanQuery, folders?: readonly NormalizedFolder[]): string {
  const parts: string[] = [];

  const where =
    q.folders.length === 0
      ? 'all unprotected folders'
      : q.folders
          .map((f) => {
            if (!f.startsWith('folder:')) return f;
            const id = f.slice('folder:'.length);
            return folders?.find((x) => x.remoteId === id)?.path ?? id;
          })
          .join(', ');
  parts.push(`in ${where}`);

  if (q.keywords.length > 0) {
    parts.push(
      `containing ${q.keywordMatch === 'all' ? 'all of' : 'any of'} [${q.keywords.join(', ')}] (${q.keywordScope})`,
    );
  }
  if (q.from.length > 0) parts.push(`from ${q.from.join(' or ')}`);
  if (q.to.length > 0) parts.push(`to ${q.to.join(' or ')}`);
  if (q.olderThanDays !== undefined) parts.push(`older than ${q.olderThanDays} days`);
  if (q.newerThanDays !== undefined) parts.push(`newer than ${q.newerThanDays} days`);
  if (q.before) parts.push(`sent before ${q.before}`);
  if (q.after) parts.push(`sent after ${q.after}`);
  if (q.largerThanBytes !== undefined) parts.push(`larger than ${formatBytes(q.largerThanBytes)}`);
  if (q.smallerThanBytes !== undefined) parts.push(`smaller than ${formatBytes(q.smallerThanBytes)}`);
  if (q.readState !== 'any') parts.push(q.readState);
  if (q.hasAttachment !== undefined) parts.push(q.hasAttachment ? 'with attachments' : 'without attachments');
  if (q.excludeStarred) parts.push('excluding starred/flagged');
  if (q.excludeKeywords.length > 0) parts.push(`not containing [${q.excludeKeywords.join(', ')}]`);
  if (q.excludeFrom.length > 0) parts.push(`not from ${q.excludeFrom.join(' or ')}`);
  if (q.limit !== undefined) parts.push(`limit ${q.limit}`);

  return `Messages ${parts.join('; ')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
