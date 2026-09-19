import { apiFetch, chunk } from '../http.js';
import { TokenBucket, withRetry } from '../../lib/retry.js';
import { resolveDateWindow } from '../query.js';
import type { TokenSet } from '../oauth.js';
import type {
  BulkOutcome,
  CleanQuery,
  CompiledQuery,
  DeleteMode,
  FolderRole,
  MailProvider,
  MessageRef,
  NormalizedFolder,
  ProviderCapabilities,
  ResidualFilter,
  SearchOptions,
} from '../types.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

/** $search on messages is hard-capped at 1000 results per query by Exchange. */
const SEARCH_RESULT_CAP = 1000;
/** $batch accepts at most 20 sub-requests. */
const BATCH_SIZE = 20;
const PAGE_SIZE = 100;

const SELECT = [
  'id',
  'subject',
  'from',
  'toRecipients',
  'receivedDateTime',
  'sentDateTime',
  'isRead',
  'hasAttachments',
  'flag',
  'parentFolderId',
  'bodyPreview',
].join(',');

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

interface GraphMessage {
  id: string;
  subject?: string | null;
  from?: GraphRecipient | null;
  toRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  flag?: { flagStatus?: 'notFlagged' | 'complete' | 'flagged' };
  parentFolderId?: string;
  bodyPreview?: string;
  body?: { contentType?: string; content?: string };
}

interface GraphFolder {
  id: string;
  displayName: string;
  totalItemCount?: number;
  unreadItemCount?: number;
  childFolderCount?: number;
}

/**
 * Outlook has no Promotions/Social/Forums split — those roles simply resolve to
 * nothing on this provider and the caller is told so, rather than silently
 * widening to the whole mailbox.
 */
const WELL_KNOWN: Array<{ name: string; role: FolderRole }> = [
  { name: 'inbox', role: 'inbox' },
  { name: 'junkemail', role: 'spam' },
  { name: 'deleteditems', role: 'trash' },
  { name: 'drafts', role: 'drafts' },
  { name: 'sentitems', role: 'sent' },
  { name: 'archive', role: 'archive' },
];

const addressOf = (r: GraphRecipient | null | undefined): string | null => {
  const email = r?.emailAddress;
  if (!email) return null;
  return email.name ? `${email.name} <${email.address ?? ''}>` : (email.address ?? null);
};

/** KQL dates are US-format and the range operator is inclusive on both ends. */
const kqlDate = (d: Date): string =>
  `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;

const kqlQuote = (term: string): string => `"${term.replace(/["\\]/g, '\\$&')}"`;

export interface MsNativeQuery {
  /** KQL string for $search, or null when $filter is usable instead. */
  search: string | null;
  /** OData $filter, used only when there is no $search (they are exclusive). */
  filter: string | null;
  /** Date bounds, carried separately so search windows can be subdivided. */
  after: string | null;
  before: string | null;
}

export class MicrosoftProvider implements MailProvider {
  readonly id = 'microsoft' as const;
  readonly capabilities: ProviderCapabilities = {
    serverSideKeywordSearch: true,
    searchesBody: true,
    permanentDelete: true,
    restoreFromTrash: true,
    maxSearchResults: SEARCH_RESULT_CAP,
    batchSize: BATCH_SIZE,
    supportsSizeFilter: false,
    supportsAttachmentFilter: true,
    supportsReadStateFilter: true,
    exactCounts: true,
  };

  // Graph throttles per mailbox at roughly 10k requests / 10 min; this keeps a
  // comfortable margin while still moving fast.
  #bucket = new TokenBucket(20, 8);
  #folderCache: NormalizedFolder[] | null = null;

  constructor(
    readonly accountId: string,
    private readonly tokens: TokenSet,
  ) {}

  async #call<T>(req: Parameters<typeof apiFetch>[2], signal?: AbortSignal): Promise<T> {
    await this.#bucket.take(1, signal);
    return withRetry(() => apiFetch<T>('microsoft', this.tokens.accessToken, { ...req, signal }), {
      label: 'microsoft',
      signal,
    });
  }

  async verify(): Promise<{ email: string; displayName?: string | null }> {
    const me = await this.#call<{ mail?: string; userPrincipalName?: string; displayName?: string }>({
      url: `${GRAPH}/me?$select=mail,userPrincipalName,displayName`,
    });
    return {
      email: me.mail ?? me.userPrincipalName ?? '',
      displayName: me.displayName ?? null,
    };
  }

  async listFolders(): Promise<NormalizedFolder[]> {
    if (this.#folderCache) return this.#folderCache;

    // Resolve well-known folders first so roles come from Exchange itself
    // rather than from display names, which are localised.
    const roleById = new Map<string, FolderRole>();
    for (const { name, role } of WELL_KNOWN) {
      try {
        const folder = await this.#call<GraphFolder>({
          url: `${GRAPH}/me/mailFolders/${name}?$select=id,displayName`,
        });
        roleById.set(folder.id, role);
      } catch {
        // Not every mailbox has every well-known folder (Archive, especially).
      }
    }

    const all = await this.#listFolderTree(`${GRAPH}/me/mailFolders?$top=${PAGE_SIZE}&$select=id,displayName,totalItemCount,unreadItemCount,childFolderCount`, '');

    this.#folderCache = all.map(({ folder, path }): NormalizedFolder => {
      const role = roleById.get(folder.id) ?? 'custom';
      return {
        remoteId: folder.id,
        name: folder.displayName,
        path,
        role,
        messageCount: folder.totalItemCount ?? null,
        unreadCount: folder.unreadItemCount ?? null,
        isProtected: role === 'sent' || role === 'drafts' || role === 'archive',
      };
    });
    return this.#folderCache;
  }

  async #listFolderTree(
    url: string,
    parentPath: string,
    depth = 0,
  ): Promise<Array<{ folder: GraphFolder; path: string }>> {
    if (depth > 6) return [];
    const out: Array<{ folder: GraphFolder; path: string }> = [];
    let next: string | undefined = url;

    while (next) {
      const page: { value: GraphFolder[]; '@odata.nextLink'?: string } = await this.#call({ url: next });
      for (const folder of page.value) {
        const path = parentPath ? `${parentPath}/${folder.displayName}` : folder.displayName;
        out.push({ folder, path });
        if ((folder.childFolderCount ?? 0) > 0) {
          out.push(
            ...(await this.#listFolderTree(
              `${GRAPH}/me/mailFolders/${folder.id}/childFolders?$top=${PAGE_SIZE}&$select=id,displayName,totalItemCount,unreadItemCount,childFolderCount`,
              path,
              depth + 1,
            )),
          );
        }
      }
      next = page['@odata.nextLink'];
    }
    return out;
  }

  compile(query: CleanQuery, folders: NormalizedFolder[]): CompiledQuery<MsNativeQuery> {
    const notes: string[] = [];
    const residual: ResidualFilter = {};
    const window = resolveDateWindow(query);

    const useSearch = query.keywords.length > 0 || query.from.length > 0 || query.to.length > 0;
    const clauses: string[] = [];

    if (useSearch) {
      if (query.keywords.length > 0) {
        const field =
          query.keywordScope === 'subject'
            ? 'subject:'
            : query.keywordScope === 'from'
              ? 'from:'
              : '';
        const parts =
          query.keywordScope === 'subject_or_from'
            ? query.keywords.map((k) => `(subject:${kqlQuote(k)} OR from:${kqlQuote(k)})`)
            : query.keywords.map((k) => `${field}${kqlQuote(k)}`);
        clauses.push(`(${parts.join(query.keywordMatch === 'all' ? ' AND ' : ' OR ')})`);
      }
      if (query.from.length > 0) {
        clauses.push(`(${query.from.map((f) => `from:${kqlQuote(f)}`).join(' OR ')})`);
      }
      if (query.to.length > 0) {
        clauses.push(`(${query.to.map((t) => `to:${kqlQuote(t)}`).join(' OR ')})`);
      }
      // KQL carries the date range too, because Graph refuses $search + $filter.
      if (window.after || window.before) {
        const from = window.after ? kqlDate(window.after) : '01/01/1990';
        const to = window.before ? kqlDate(window.before) : kqlDate(new Date());
        clauses.push(`received:${from}..${to}`);
        notes.push(
          'Outlook cannot combine keyword search with an OData date filter, so dates are expressed in the search itself and re-checked locally to the exact second.',
        );
        residual.sentAfter = window.after?.toISOString();
        residual.sentBefore = window.before?.toISOString();
      }
      notes.push(
        `Outlook caps each search at ${SEARCH_RESULT_CAP} results; larger matches are collected by splitting the date range automatically.`,
      );
      // Everything below is unavailable inside KQL for messages, so it runs locally.
      if (query.readState !== 'any') residual.readState = query.readState;
      if (query.hasAttachment !== undefined) residual.hasAttachment = query.hasAttachment;
      if (query.excludeStarred) residual.excludeStarred = true;
      if (query.excludeKeywords.length > 0) residual.excludeKeywords = [...query.excludeKeywords];
      if (query.excludeFrom.length > 0) residual.excludeFrom = [...query.excludeFrom];
    } else {
      const filters: string[] = [];
      if (window.before) filters.push(`receivedDateTime lt ${window.before.toISOString()}`);
      if (window.after) filters.push(`receivedDateTime ge ${window.after.toISOString()}`);
      if (query.readState === 'read') filters.push('isRead eq true');
      if (query.readState === 'unread') filters.push('isRead eq false');
      if (query.hasAttachment !== undefined) filters.push(`hasAttachments eq ${query.hasAttachment}`);
      if (query.excludeStarred) residual.excludeStarred = true;
      if (query.excludeKeywords.length > 0) residual.excludeKeywords = [...query.excludeKeywords];
      if (query.excludeFrom.length > 0) residual.excludeFrom = [...query.excludeFrom];
      notes.push('Outlook evaluates this query with an OData filter, so results are exact and unlimited.');
      return {
        native: {
          search: null,
          filter: filters.length > 0 ? filters.join(' and ') : null,
          after: window.after?.toISOString() ?? null,
          before: window.before?.toISOString() ?? null,
        },
        folders,
        residual,
        notes,
      };
    }

    if (query.largerThanBytes !== undefined || query.smallerThanBytes !== undefined) {
      notes.push('Outlook does not expose message size on the messages collection; size filters are ignored.');
    }

    return {
      native: {
        search: clauses.join(' AND '),
        filter: null,
        after: window.after?.toISOString() ?? null,
        before: window.before?.toISOString() ?? null,
      },
      folders,
      residual,
      notes,
    };
  }

  async *search(compiled: CompiledQuery, opts: SearchOptions = {}): AsyncGenerator<MessageRef[]> {
    const native = compiled.native as MsNativeQuery;
    let yielded = 0;

    for (const folder of compiled.folders) {
      const pages = native.search
        ? this.#searchWindowed(folder, native, opts)
        : this.#filterPaged(folder, native, opts);

      for await (const refs of pages) {
        if (refs.length === 0) continue;
        yielded += refs.length;
        opts.onProgress?.(yielded);
        if (opts.max && yielded > opts.max) {
          yield refs.slice(0, refs.length - (yielded - opts.max));
          return;
        }
        yield refs;
      }
    }
  }

  /** Straightforward OData paging — no result ceiling. */
  async *#filterPaged(
    folder: NormalizedFolder,
    native: MsNativeQuery,
    opts: SearchOptions,
  ): AsyncGenerator<MessageRef[]> {
    const url = new URL(`${GRAPH}/me/mailFolders/${folder.remoteId}/messages`);
    url.searchParams.set('$top', String(PAGE_SIZE));
    url.searchParams.set('$select', SELECT);
    url.searchParams.set('$orderby', 'receivedDateTime desc');
    if (native.filter) url.searchParams.set('$filter', native.filter);

    let next: string | undefined = url.toString();
    while (next) {
      if (opts.signal?.aborted) return;
      const page: { value: GraphMessage[]; '@odata.nextLink'?: string } = await this.#call(
        { url: next },
        opts.signal,
      );
      yield page.value.map((m) => this.#toRef(m, folder.remoteId));
      next = page['@odata.nextLink'];
    }
  }

  /**
   * $search tops out at 1000 results with no way to page past it. When a window
   * comes back full we bisect its date range and search each half, which walks
   * the whole matching set without ever asking for result 1001.
   */
  async *#searchWindowed(
    folder: NormalizedFolder,
    native: MsNativeQuery,
    opts: SearchOptions,
  ): AsyncGenerator<MessageRef[]> {
    const start = native.after ? new Date(native.after) : new Date('1995-01-01T00:00:00Z');
    const end = native.before ? new Date(native.before) : new Date(Date.now() + 86_400_000);

    const queue: Array<[Date, Date, number]> = [[start, end, 0]];
    const seen = new Set<string>();

    while (queue.length > 0) {
      const [from, to, depth] = queue.pop() as [Date, Date, number];
      if (opts.signal?.aborted) return;

      const kql = this.#withWindow(native.search as string, from, to);
      const messages = await this.#searchOnce(folder, kql, opts.signal);

      // A full page means results were almost certainly truncated. Bisecting
      // below a day is pointless, so accept the truncation and note it.
      if (messages.length >= SEARCH_RESULT_CAP && depth < 12 && to.getTime() - from.getTime() > 86_400_000) {
        const mid = new Date((from.getTime() + to.getTime()) / 2);
        queue.push([from, mid, depth + 1], [mid, to, depth + 1]);
        continue;
      }

      const refs: MessageRef[] = [];
      for (const m of messages) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        refs.push(this.#toRef(m, folder.remoteId));
      }
      yield refs;
    }
  }

  /** Replaces or appends the received: range clause for a sub-window. */
  #withWindow(kql: string, from: Date, to: Date): string {
    const clause = `received:${kqlDate(from)}..${kqlDate(to)}`;
    return /received:\S+\.\.\S+/.test(kql)
      ? kql.replace(/received:\S+\.\.\S+/, clause)
      : `${kql} AND ${clause}`;
  }

  async #searchOnce(
    folder: NormalizedFolder,
    kql: string,
    signal: AbortSignal | undefined,
  ): Promise<GraphMessage[]> {
    const out: GraphMessage[] = [];
    const url = new URL(`${GRAPH}/me/mailFolders/${folder.remoteId}/messages`);
    url.searchParams.set('$top', String(PAGE_SIZE));
    url.searchParams.set('$select', SELECT);
    url.searchParams.set('$search', `"${kql.replace(/"/g, '\\"')}"`);

    let next: string | undefined = url.toString();
    while (next && out.length < SEARCH_RESULT_CAP) {
      if (signal?.aborted) break;
      const page: { value: GraphMessage[]; '@odata.nextLink'?: string } = await this.#call({ url: next }, signal);
      out.push(...page.value);
      next = page['@odata.nextLink'];
    }
    return out;
  }

  #toRef(m: GraphMessage, folderRemoteId: string): MessageRef {
    return {
      id: m.id,
      folderRemoteId: m.parentFolderId ?? folderRemoteId,
      subject: m.subject ?? null,
      from: addressOf(m.from),
      to: (m.toRecipients ?? []).map(addressOf).filter(Boolean).join(', ') || null,
      sentAt: m.receivedDateTime ?? m.sentDateTime ?? null,
      sizeBytes: null,
      isStarred: m.flag?.flagStatus === 'flagged',
      isUnread: m.isRead === undefined ? undefined : !m.isRead,
      hasAttachment: m.hasAttachments,
      bodyText: m.body?.content ?? m.bodyPreview ?? null,
    };
  }

  async hydrate(refs: MessageRef[], need: { body: boolean }): Promise<MessageRef[]> {
    if (!need.body) return refs;
    const out: MessageRef[] = [];
    for (const batch of chunk(refs, BATCH_SIZE)) {
      const responses = await this.#batch(
        batch.map((ref) => ({
          id: ref.id,
          method: 'GET' as const,
          url: `/me/messages/${ref.id}?$select=${SELECT},body`,
        })),
      );
      for (const ref of batch) {
        const res = responses.get(ref.id);
        const body = res?.body as GraphMessage | undefined;
        out.push(res?.status === 200 && body ? this.#toRef(body, ref.folderRemoteId ?? '') : ref);
      }
    }
    return out;
  }

  async delete(refs: MessageRef[], mode: DeleteMode): Promise<BulkOutcome> {
    return this.#bulkOp(refs, (ref) =>
      mode === 'permanent'
        ? { id: ref.id, method: 'POST' as const, url: `/me/messages/${ref.id}/permanentDelete` }
        : { id: ref.id, method: 'DELETE' as const, url: `/me/messages/${ref.id}` },
    );
  }

  async restore(refs: MessageRef[]): Promise<BulkOutcome> {
    // Restore puts messages back where they came from when we recorded it,
    // falling back to the Inbox.
    return this.#bulkOp(refs, (ref) => ({
      id: ref.id,
      method: 'POST' as const,
      url: `/me/messages/${ref.id}/move`,
      headers: { 'content-type': 'application/json' },
      body: { destinationId: ref.folderRemoteId ?? 'inbox' },
    }));
  }

  async #bulkOp(
    refs: MessageRef[],
    build: (ref: MessageRef) => GraphBatchRequest,
  ): Promise<BulkOutcome> {
    const outcome: BulkOutcome = { succeeded: [], failed: [] };
    for (const batch of chunk(refs, BATCH_SIZE)) {
      let responses: Map<string, GraphBatchResponse>;
      try {
        responses = await this.#batch(batch.map(build));
      } catch (err) {
        const message = (err as Error).message;
        for (const ref of batch) outcome.failed.push({ id: ref.id, error: message });
        continue;
      }
      for (const ref of batch) {
        const res = responses.get(ref.id);
        // 404 means it is already gone — treat that as success, not failure.
        if (res && ((res.status >= 200 && res.status < 300) || res.status === 404)) {
          outcome.succeeded.push(ref.id);
        } else {
          outcome.failed.push({
            id: ref.id,
            error: describeBatchError(res),
          });
        }
      }
    }
    return outcome;
  }

  async #batch(requests: GraphBatchRequest[]): Promise<Map<string, GraphBatchResponse>> {
    const response = await this.#call<{ responses: GraphBatchResponse[] }>({
      url: `${GRAPH}/$batch`,
      method: 'POST',
      body: { requests },
    });
    return new Map((response.responses ?? []).map((r) => [r.id, r]));
  }

  async close(): Promise<void> {
    // Stateless HTTP client; nothing to release.
  }
}

interface GraphBatchRequest {
  id: string;
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface GraphBatchResponse {
  id: string;
  status: number;
  body?: unknown;
}

function describeBatchError(res: GraphBatchResponse | undefined): string {
  if (!res) return 'No response in batch result';
  const body = res.body as { error?: { code?: string; message?: string } } | undefined;
  return body?.error?.message ?? body?.error?.code ?? `HTTP ${res.status}`;
}
