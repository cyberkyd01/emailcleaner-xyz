import { describe, expect, it } from 'vitest';
import { parseCleanQuery } from '../src/providers/query.js';
import { planClean, streamMatches, deleteRefs } from '../src/services/engine.js';
import { defaultProtections, type AccountProtections } from '../src/services/accounts.js';
import type {
  BulkOutcome,
  CleanQuery,
  CompiledQuery,
  DeleteMode,
  MailProvider,
  MessageRef,
  NormalizedFolder,
  ProviderCapabilities,
  ResidualFilter,
} from '../src/providers/types.js';

/**
 * A deliberately weak provider: its "server-side" search only filters by folder
 * and pushes everything else into the residual filter. If the engine is correct,
 * the outcome is identical to a strong provider's — just slower.
 */
class StubProvider implements MailProvider {
  readonly id = 'imap' as const;
  readonly accountId = 'acc_test';
  readonly capabilities: ProviderCapabilities = {
    serverSideKeywordSearch: false,
    searchesBody: false,
    permanentDelete: true,
    restoreFromTrash: true,
    maxSearchResults: null,
    batchSize: 50,
    supportsSizeFilter: false,
    supportsAttachmentFilter: false,
    supportsReadStateFilter: false,
    exactCounts: true,
  };

  hydrateCalls = 0;
  bodyFetches = 0;
  deleted: Array<{ ids: string[]; mode: DeleteMode }> = [];

  constructor(
    private readonly folders: NormalizedFolder[],
    private readonly messages: MessageRef[],
    /** Fields the search result omits, to model a metadata-poor backend. */
    private readonly hidden: Array<keyof MessageRef> = [],
  ) {}

  async verify() {
    return { email: 'test@example.com' };
  }

  async listFolders() {
    return this.folders;
  }

  compile(query: CleanQuery, folders: NormalizedFolder[]): CompiledQuery {
    // Nothing is pushed to the server except the folder scope.
    const residual: ResidualFilter = {};
    if (query.keywords.length > 0) {
      residual.keywords = { terms: query.keywords, match: query.keywordMatch, scope: query.keywordScope };
    }
    if (query.excludeKeywords.length > 0) residual.excludeKeywords = [...query.excludeKeywords];
    if (query.from.length > 0) residual.from = [...query.from];
    if (query.readState !== 'any') residual.readState = query.readState;
    return { native: {}, folders, residual, notes: ['stub provider: everything is filtered locally'] };
  }

  async *search(compiled: CompiledQuery): AsyncGenerator<MessageRef[]> {
    const scope = new Set(compiled.folders.map((f) => f.remoteId));
    const visible = this.messages
      .filter((m) => scope.has(m.folderRemoteId ?? ''))
      .map((m) => {
        const stripped = { ...m };
        for (const field of this.hidden) delete stripped[field];
        return stripped;
      });
    // Two pages, to exercise the paging path.
    const half = Math.ceil(visible.length / 2) || 1;
    for (let i = 0; i < visible.length; i += half) yield visible.slice(i, i + half);
  }

  async hydrate(refs: MessageRef[], need: { body: boolean }): Promise<MessageRef[]> {
    this.hydrateCalls++;
    if (need.body) this.bodyFetches += refs.length;
    return refs.map((ref) => {
      const full = this.messages.find((m) => m.id === ref.id) as MessageRef;
      return need.body ? full : { ...full, bodyText: null };
    });
  }

  async delete(refs: MessageRef[], mode: DeleteMode): Promise<BulkOutcome> {
    this.deleted.push({ ids: refs.map((r) => r.id), mode });
    return { succeeded: refs.map((r) => r.id), failed: [] };
  }

  async restore(refs: MessageRef[]): Promise<BulkOutcome> {
    return { succeeded: refs.map((r) => r.id), failed: [] };
  }

  async close(): Promise<void> {}
}

const folder = (remoteId: string, role: NormalizedFolder['role'], isProtected = false): NormalizedFolder => ({
  remoteId,
  name: remoteId,
  path: remoteId,
  role,
  messageCount: null,
  unreadCount: null,
  isProtected,
});

const FOLDERS = [
  folder('INBOX', 'inbox'),
  folder('Promotions', 'promotions'),
  folder('Bulk Mail', 'spam'),
  folder('Sent', 'sent', true),
  folder('Receipts', 'custom'),
];

const msg = (id: string, over: Partial<MessageRef> = {}): MessageRef => ({
  id,
  folderRemoteId: 'Promotions',
  subject: 'Weekend sale',
  from: 'deals@shop.example',
  to: 'me@example.com',
  sentAt: '2026-03-01T12:00:00.000Z',
  sizeBytes: 5_000,
  isStarred: false,
  isUnread: true,
  hasAttachment: false,
  bodyText: 'Big discounts inside',
  ...over,
});

const MESSAGES: MessageRef[] = [
  msg('p1'),
  msg('p2', { subject: 'Your invoice is ready', bodyText: 'invoice attached', from: 'billing@bank.example' }),
  msg('p3', { isStarred: true, subject: 'Starred sale' }),
  msg('i1', { folderRemoteId: 'INBOX', subject: 'Weekend sale in your inbox' }),
  msg('s1', { folderRemoteId: 'Sent', subject: 'Re: Weekend sale' }),
  msg('b1', { folderRemoteId: 'Bulk Mail', subject: 'sale sale sale' }),
];

async function collect(provider: MailProvider, query: CleanQuery, protections: AccountProtections = defaultProtections()) {
  const plan = await planClean(provider, query, protections);
  const ids: string[] = [];
  for await (const batch of streamMatches(provider, plan)) ids.push(...batch.refs.map((r) => r.id));
  return { plan, ids };
}

describe('planClean', () => {
  it('excludes protected folders from an unqualified selection', async () => {
    const provider = new StubProvider(FOLDERS, MESSAGES);
    const { plan } = await collect(provider, parseCleanQuery({ keywords: ['sale'] }));
    expect(plan.folders.map((f) => f.remoteId)).not.toContain('Sent');
    expect(plan.folders.map((f) => f.remoteId)).toEqual(
      expect.arrayContaining(['INBOX', 'Promotions', 'Bulk Mail', 'Receipts']),
    );
  });

  it('includes a protected folder when it is named explicitly, and warns', async () => {
    const provider = new StubProvider(FOLDERS, MESSAGES);
    const { plan } = await collect(provider, parseCleanQuery({ folders: ['sent'], keywords: ['sale'] }));
    expect(plan.folders.map((f) => f.remoteId)).toEqual(['Sent']);
    expect(plan.warnings.join(' ')).toMatch(/mail worth keeping/i);
  });

  it('drops folders the account owner marked protected and says so', async () => {
    const provider = new StubProvider(FOLDERS, MESSAGES);
    const { plan } = await collect(
      provider,
      parseCleanQuery({ folders: ['promotions', 'inbox'], keywords: ['sale'] }),
      { ...defaultProtections(), folders: ['INBOX'] },
    );
    expect(plan.folders.map((f) => f.remoteId)).toEqual(['Promotions']);
    expect(plan.warnings.join(' ')).toMatch(/is protected on this account/);
  });

  it('refuses a query that resolves to no folders at all', async () => {
    const provider = new StubProvider([folder('INBOX', 'inbox')], []);
    await expect(collect(provider, parseCleanQuery({ folders: ['forums'] }))).rejects.toThrow(/None of the requested folders exist/i);
  });

  it('flags that bodies must be fetched when keywords search everywhere', async () => {
    const provider = new StubProvider(FOLDERS, MESSAGES);
    const { plan } = await collect(provider, parseCleanQuery({ keywords: ['discounts'] }));
    expect(plan.requiresBody).toBe(true);
    expect(plan.warnings.join(' ')).toMatch(/message bodies/i);
  });
});

describe('streamMatches', () => {
  it('applies the residual filter a weak provider could not push server-side', async () => {
    const provider = new StubProvider(FOLDERS, MESSAGES);
    const { ids } = await collect(provider, parseCleanQuery({ folders: ['promotions'], keywords: ['sale'] }));
    // p2 is an invoice, p3 is starred — neither should survive.
    expect(ids).toEqual(['p1']);
  });

  it('honours an exclude-keyword veto', async () => {
    const provider = new StubProvider(FOLDERS, MESSAGES);
    const { ids } = await collect(
      provider,
      parseCleanQuery({ folders: ['promotions', 'inbox'], keywords: ['sale'], excludeKeywords: ['inbox'] }),
    );
    expect(ids).toEqual(['p1']);
  });

  it('enforces account-level sender protection over the rule', async () => {
    const provider = new StubProvider(FOLDERS, MESSAGES);
    const { ids } = await collect(
      provider,
      parseCleanQuery({ folders: ['promotions'], keywords: ['sale'] }),
      { ...defaultProtections(), senders: ['shop.example'] },
    );
    expect(ids).toEqual([]);
  });

  it('never deletes a message it cannot fully evaluate', async () => {
    // This provider hides the starred flag from search results entirely.
    const provider = new StubProvider(FOLDERS, MESSAGES, ['isStarred']);
    const { ids } = await collect(provider, parseCleanQuery({ folders: ['promotions'], keywords: ['sale'] }));
    // Hydration restores the flag, so the starred message is still protected.
    expect(ids).toEqual(['p1']);
    expect(provider.hydrateCalls).toBeGreaterThan(0);
  });

  it('stops at the requested limit', async () => {
    const provider = new StubProvider(FOLDERS, MESSAGES);
    const plan = await planClean(provider, parseCleanQuery({ folders: ['promotions', 'inbox', 'spam'], keywords: ['sale'] }), defaultProtections());
    const ids: string[] = [];
    for await (const batch of streamMatches(provider, plan, { limit: 2 })) ids.push(...batch.refs.map((r) => r.id));
    expect(ids).toHaveLength(2);
  });

  it('fetches bodies only when a residual keyword actually needs them', async () => {
    const subjectOnly = new StubProvider(FOLDERS, MESSAGES);
    await collect(subjectOnly, parseCleanQuery({ folders: ['promotions'], keywords: ['sale'], keywordScope: 'subject' }));
    expect(subjectOnly.bodyFetches).toBe(0);

    const anywhere = new StubProvider(FOLDERS, MESSAGES);
    await collect(anywhere, parseCleanQuery({ folders: ['promotions'], keywords: ['discounts'] }));
    expect(anywhere.bodyFetches).toBeGreaterThan(0);
  });
});

describe('deleteRefs', () => {
  it('passes the mode through to the provider', async () => {
    const provider = new StubProvider(FOLDERS, MESSAGES);
    const outcome = await deleteRefs(provider, [msg('p1')], 'permanent');
    expect(outcome.succeeded).toEqual(['p1']);
    expect(provider.deleted[0]?.mode).toBe('permanent');
  });

  it('is a no-op on an empty set', async () => {
    const provider = new StubProvider(FOLDERS, MESSAGES);
    await deleteRefs(provider, [], 'trash');
    expect(provider.deleted).toHaveLength(0);
  });
});
