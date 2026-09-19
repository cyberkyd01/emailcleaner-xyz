import { describe, expect, it } from 'vitest';
import { parseCleanQuery } from '../src/providers/query.js';
import { GmailProvider, type GmailNativeQuery } from '../src/providers/gmail/adapter.js';
import { MicrosoftProvider, type MsNativeQuery } from '../src/providers/microsoft/adapter.js';
import { ImapProvider, type ImapNativeQuery } from '../src/providers/imap/adapter.js';
import { discoverImapSettings } from '../src/providers/imap/autodiscover.js';
import { encryptSecret, decryptSecret, hashPassword, verifyPassword } from '../src/lib/crypto.js';
import type { NormalizedFolder } from '../src/providers/types.js';

const tokens = { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 3_600_000, scope: '' };

const folders = (...defs: Array<[string, NormalizedFolder['role']]>): NormalizedFolder[] =>
  defs.map(([remoteId, role]) => ({
    remoteId,
    name: remoteId,
    path: remoteId,
    role,
    messageCount: null,
    unreadCount: null,
    isProtected: false,
  }));

describe('Gmail query compilation', () => {
  const gmail = new GmailProvider('acc', tokens);

  it('quotes keywords and ORs them by default', () => {
    const q = parseCleanQuery({ keywords: ['black friday', 'sale'] });
    const native = gmail.compile(q, folders(['CATEGORY_PROMOTIONS', 'promotions'])).native as GmailNativeQuery;
    expect(native.q).toContain('("black friday" OR "sale")');
  });

  it('ANDs keywords when match is all', () => {
    const q = parseCleanQuery({ keywords: ['invoice', 'overdue'], keywordMatch: 'all' });
    const native = gmail.compile(q, folders(['INBOX', 'inbox'])).native as GmailNativeQuery;
    expect(native.q).toContain('"invoice" "overdue"');
    expect(native.q).not.toContain(' OR ');
  });

  it('adds the starred and important guards', () => {
    const q = parseCleanQuery({ keywords: ['x'] });
    const native = gmail.compile(q, folders(['INBOX', 'inbox'])).native as GmailNativeQuery;
    expect(native.q).toContain('-is:starred');
    expect(native.q).toContain('-is:important');
  });

  it('opts into spam and trash only when those folders were chosen', () => {
    const q = parseCleanQuery({ folders: ['spam'] });
    expect((gmail.compile(q, folders(['SPAM', 'spam'])).native as GmailNativeQuery).includeSpamTrash).toBe(true);
    expect((gmail.compile(q, folders(['INBOX', 'inbox'])).native as GmailNativeQuery).includeSpamTrash).toBe(false);
  });

  it('uses epoch seconds for dates to dodge the PST midnight rule', () => {
    const q = parseCleanQuery({ keywords: ['x'], olderThanDays: 30 });
    const native = gmail.compile(q, folders(['INBOX', 'inbox'])).native as GmailNativeQuery;
    expect(native.q).toMatch(/before:\d{10}/);
  });

  it('needs no local re-filtering, because Gmail can express the whole query', () => {
    const q = parseCleanQuery({ keywords: ['x'], olderThanDays: 10, largerThanBytes: 1000 });
    expect(gmail.compile(q, folders(['INBOX', 'inbox'])).residual).toEqual({});
  });

  it('refuses permanent delete without the restricted scope', async () => {
    await expect(
      gmail.delete([{ id: 'm', folderRemoteId: 'INBOX' }], 'permanent'),
    ).rejects.toThrow(/mail\.google\.com/);
  });
});

describe('Microsoft query compilation', () => {
  const ms = new MicrosoftProvider('acc', tokens);

  it('uses an OData filter when there are no keywords', () => {
    const q = parseCleanQuery({ folders: ['inbox'], olderThanDays: 90 });
    const native = ms.compile(q, folders(['id1', 'inbox'])).native as MsNativeQuery;
    expect(native.search).toBeNull();
    expect(native.filter).toContain('receivedDateTime lt');
  });

  it('switches to KQL when keywords appear, since $search and $filter are exclusive', () => {
    const q = parseCleanQuery({ keywords: ['newsletter'], olderThanDays: 90 });
    const native = ms.compile(q, folders(['id1', 'inbox'])).native as MsNativeQuery;
    expect(native.filter).toBeNull();
    expect(native.search).toContain('"newsletter"');
    expect(native.search).toMatch(/received:\d{2}\/\d{2}\/\d{4}\.\.\d{2}\/\d{2}\/\d{4}/);
  });

  it('pushes everything KQL cannot express into the residual filter', () => {
    const q = parseCleanQuery({ keywords: ['x'], readState: 'unread', excludeKeywords: ['receipt'] });
    const compiled = ms.compile(q, folders(['id1', 'inbox']));
    expect(compiled.residual.readState).toBe('unread');
    expect(compiled.residual.excludeKeywords).toEqual(['receipt']);
    expect(compiled.residual.excludeStarred).toBe(true);
  });

  it('warns that size filters do not exist on this provider', () => {
    const q = parseCleanQuery({ keywords: ['x'], largerThanBytes: 5_000_000 });
    expect(ms.compile(q, folders(['id1', 'inbox'])).notes.join(' ')).toMatch(/size/i);
  });

  it('explains the 1000-result ceiling in the preview notes', () => {
    const q = parseCleanQuery({ keywords: ['x'] });
    expect(ms.compile(q, folders(['id1', 'inbox'])).notes.join(' ')).toContain('1000');
  });
});

describe('IMAP query compilation', () => {
  const imap = new ImapProvider('acc', { host: 'imap.mail.yahoo.com', port: 993, secure: true, user: 'a@yahoo.com', password: 'p' });

  it('uses a single search with OR for any-match keywords', () => {
    const q = parseCleanQuery({ keywords: ['a', 'b'] });
    const native = imap.compile(q, folders(['INBOX', 'inbox'])).native as ImapNativeQuery;
    expect(native.searches).toHaveLength(1);
    expect(native.intersect).toBe(false);
    expect(native.searches[0]?.or).toHaveLength(2);
  });

  it('intersects one search per term for all-match keywords', () => {
    const q = parseCleanQuery({ keywords: ['a', 'b'], keywordMatch: 'all' });
    const native = imap.compile(q, folders(['INBOX', 'inbox'])).native as ImapNativeQuery;
    expect(native.searches).toHaveLength(2);
    expect(native.intersect).toBe(true);
  });

  it('re-checks dates locally because IMAP only compares whole days', () => {
    const q = parseCleanQuery({ keywords: ['x'], olderThanDays: 30 });
    expect(imap.compile(q, folders(['INBOX', 'inbox'])).residual.sentBefore).toBeTruthy();
  });

  it('defers attachment filtering to the local pass', () => {
    const q = parseCleanQuery({ keywords: ['x'], hasAttachment: true });
    expect(imap.compile(q, folders(['INBOX', 'inbox'])).residual.hasAttachment).toBe(true);
  });

  it('excludes flagged mail at the server', () => {
    const q = parseCleanQuery({ keywords: ['x'] });
    const native = imap.compile(q, folders(['INBOX', 'inbox'])).native as ImapNativeQuery;
    expect(native.searches[0]?.flagged).toBe(false);
  });
});

describe('IMAP autodiscovery', () => {
  it('knows the mass-market providers without a network call', async () => {
    const yahoo = await discoverImapSettings('someone@yahoo.com');
    expect(yahoo.host).toBe('imap.mail.yahoo.com');
    expect(yahoo.source).toBe('builtin');
    expect(yahoo.guidance).toMatch(/app password/i);

    const mailcom = await discoverImapSettings('someone@mail.com');
    expect(mailcom.host).toBe('imap.mail.com');
    expect(mailcom.guidance).toMatch(/POP3 & IMAP/i);
  });

  it('rejects a malformed address', async () => {
    await expect(discoverImapSettings('not-an-address')).rejects.toThrow();
  });
});

describe('credential storage', () => {
  it('round-trips a secret bound to its account id', () => {
    const blob = encryptSecret('app-password', 'acc_1');
    expect(blob).not.toContain('app-password');
    expect(decryptSecret(blob, 'acc_1')).toBe('app-password');
  });

  it('refuses to decrypt a secret lifted into another account row', () => {
    const blob = encryptSecret('app-password', 'acc_1');
    expect(() => decryptSecret(blob, 'acc_2')).toThrow();
  });

  it('produces a different ciphertext each time', () => {
    expect(encryptSecret('same', 'a')).not.toBe(encryptSecret('same', 'a'));
  });

  it('verifies passwords and rejects wrong ones', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
});
