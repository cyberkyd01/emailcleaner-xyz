import { describe, expect, it } from 'vitest';
import {
  matchesResidual,
  parseCleanQuery,
  resolveDateWindow,
  resolveFolders,
} from '../src/providers/query.js';
import type { MessageRef, NormalizedFolder } from '../src/providers/types.js';

const folder = (over: Partial<NormalizedFolder> & { remoteId: string; role: NormalizedFolder['role'] }): NormalizedFolder => ({
  name: over.remoteId,
  path: over.remoteId,
  messageCount: null,
  unreadCount: null,
  isProtected: false,
  ...over,
});

const FOLDERS: NormalizedFolder[] = [
  folder({ remoteId: 'INBOX', role: 'inbox' }),
  folder({ remoteId: 'CATEGORY_PROMOTIONS', role: 'promotions' }),
  folder({ remoteId: 'SPAM', role: 'spam' }),
  folder({ remoteId: 'TRASH', role: 'trash' }),
  folder({ remoteId: 'SENT', role: 'sent', isProtected: true }),
  folder({ remoteId: 'Label_9', role: 'custom', path: 'Receipts' }),
];

const ref = (over: Partial<MessageRef> = {}): MessageRef => ({
  id: 'm1',
  folderRemoteId: 'INBOX',
  subject: 'Half price sneakers',
  from: 'deals@shop.example',
  to: 'me@example.com',
  sentAt: '2026-01-15T10:00:00.000Z',
  sizeBytes: 10_000,
  isStarred: false,
  isUnread: true,
  hasAttachment: false,
  bodyText: 'Clearance sale ends tonight',
  ...over,
});

describe('parseCleanQuery', () => {
  it('rejects a query with no selector at all', () => {
    expect(() => parseCleanQuery({})).toThrowError(/unbounded/i);
  });

  it('accepts a keyword-only query and applies safe defaults', () => {
    const q = parseCleanQuery({ keywords: ['invoice'] });
    expect(q.folders).toEqual([]);
    expect(q.excludeStarred).toBe(true);
    expect(q.excludeImportant).toBe(true);
    expect(q.keywordMatch).toBe('any');
    expect(q.keywordScope).toBe('anywhere');
  });

  it('rejects unknown folder selectors', () => {
    expect(() => parseCleanQuery({ folders: ['inboxx'] })).toThrowError(/Unknown folder selector/);
  });

  it('accepts explicit folder ids', () => {
    expect(parseCleanQuery({ folders: ['folder:Label_9'] }).folders).toEqual(['folder:Label_9']);
  });

  it('rejects contradictory age bounds', () => {
    expect(() => parseCleanQuery({ olderThanDays: 30, newerThanDays: 60 })).toThrowError(/newerThanDays/);
  });

  it('deduplicates keyword lists', () => {
    expect(parseCleanQuery({ keywords: ['a', 'a', 'b'] }).keywords).toEqual(['a', 'b']);
  });

  it('refuses unknown fields rather than silently ignoring them', () => {
    expect(() => parseCleanQuery({ keywords: ['x'], deleteEverything: true })).toThrow();
  });
});

describe('resolveDateWindow', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('converts olderThanDays into an upper bound', () => {
    const w = resolveDateWindow(parseCleanQuery({ keywords: ['x'], olderThanDays: 30 }), now);
    expect(w.before?.toISOString()).toBe('2026-05-02T00:00:00.000Z');
  });

  it('keeps the tighter of the relative and absolute upper bounds', () => {
    const w = resolveDateWindow(
      parseCleanQuery({ keywords: ['x'], olderThanDays: 30, before: '2026-01-01' }),
      now,
    );
    expect(w.before?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('resolveFolders', () => {
  it('defaults to every unprotected folder', () => {
    const r = resolveFolders([], FOLDERS);
    expect(r.selected.map((f) => f.remoteId)).not.toContain('SENT');
    expect(r.selected).toHaveLength(5);
  });

  it('expands a role selector', () => {
    expect(resolveFolders(['promotions'], FOLDERS).selected.map((f) => f.remoteId)).toEqual([
      'CATEGORY_PROMOTIONS',
    ]);
  });

  it('reports selectors that match nothing instead of ignoring them', () => {
    const r = resolveFolders(['forums'], FOLDERS);
    expect(r.selected).toHaveLength(0);
    expect(r.unmatched).toEqual(['forums']);
  });

  it('flags protected folders the caller asked for explicitly', () => {
    const r = resolveFolders(['sent'], FOLDERS);
    expect(r.protectedIncluded.map((f) => f.remoteId)).toEqual(['SENT']);
  });

  it('deduplicates overlapping selectors', () => {
    const r = resolveFolders(['inbox', 'folder:INBOX'], FOLDERS);
    expect(r.selected).toHaveLength(1);
  });
});

describe('matchesResidual — the last gate before deletion', () => {
  it('passes a message through when there is nothing left to check', () => {
    expect(matchesResidual(ref(), {})).toBe(true);
  });

  it('keeps starred mail when excludeStarred is set', () => {
    expect(matchesResidual(ref({ isStarred: true }), { excludeStarred: true })).toBe(false);
  });

  it('requires every term when match is all', () => {
    const residual = { keywords: { terms: ['sneakers', 'clearance'], match: 'all' as const, scope: 'anywhere' as const } };
    expect(matchesResidual(ref(), residual)).toBe(true);
    expect(matchesResidual(ref({ bodyText: 'nothing relevant' }), residual)).toBe(false);
  });

  it('honours keyword scope', () => {
    const subjectOnly = { keywords: { terms: ['clearance'], match: 'any' as const, scope: 'subject' as const } };
    // "clearance" appears in the body, not the subject.
    expect(matchesResidual(ref(), subjectOnly)).toBe(false);
  });

  it('vetoes on an excluded keyword even when the positive match held', () => {
    expect(
      matchesResidual(ref(), {
        keywords: { terms: ['sneakers'], match: 'any', scope: 'anywhere' },
        excludeKeywords: ['clearance'],
      }),
    ).toBe(false);
  });

  it('matches senders by domain fragment', () => {
    expect(matchesResidual(ref(), { from: ['@shop.example'] })).toBe(true);
    expect(matchesResidual(ref(), { from: ['@bank.example'] })).toBe(false);
  });

  it('protects a sender on the account exclusion list', () => {
    expect(matchesResidual(ref(), { excludeFrom: ['shop.example'] })).toBe(false);
  });

  it('enforces exact date bounds that the provider could only approximate', () => {
    expect(matchesResidual(ref(), { sentBefore: '2026-02-01T00:00:00.000Z' })).toBe(true);
    expect(matchesResidual(ref(), { sentBefore: '2026-01-01T00:00:00.000Z' })).toBe(false);
    expect(matchesResidual(ref(), { sentAfter: '2026-01-01T00:00:00.000Z' })).toBe(true);
  });

  it('keeps a message whose date is unknown when a date bound applies', () => {
    expect(matchesResidual(ref({ sentAt: null }), { sentBefore: '2030-01-01T00:00:00.000Z' })).toBe(false);
  });

  it('keeps a message whose size is unknown when a size bound applies', () => {
    expect(matchesResidual(ref({ sizeBytes: null }), { minBytes: 1 })).toBe(false);
  });

  it('keeps a message whose read state is unknown when read state matters', () => {
    expect(matchesResidual(ref({ isUnread: undefined }), { readState: 'unread' })).toBe(false);
  });

  it('keeps a message whose attachment state is unknown', () => {
    expect(matchesResidual(ref({ hasAttachment: undefined }), { hasAttachment: true })).toBe(false);
  });
});
