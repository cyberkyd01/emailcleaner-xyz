import { apiFetch, chunk } from '../http.js';
import { mapConcurrent, TokenBucket, withRetry } from '../../lib/retry.js';
import { resolveDateWindow } from '../query.js';
import { ProviderError } from '../../lib/errors.js';
import { grantsPermanentDelete } from './auth.js';
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

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Gmail publishes a 250 quota-units/second/user budget, and each method has its
 * own price. These are Google's published costs — messages.get is 20, not 5,
 * and undercounting it here is what lets a burst sail past the real limit and
 * come back as a 429.
 */
const QUOTA_LIST = 5;
const QUOTA_GET = 20;
const QUOTA_LABEL_GET = 1;
const QUOTA_BATCH = 50;

/** Concurrent messages.get calls. Four at 20 units each is 80 units in flight. */
const HYDRATE_CONCURRENCY = 4;

interface GmailLabel {
  id: string;
  name: string;
  type?: 'system' | 'user';
  messagesTotal?: number;
  messagesUnread?: number;
}

interface GmailMessageStub {
  id: string;
  threadId?: string;
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  sizeEstimate?: number;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
}

/** Gmail models folders as labels; these system label ids carry the roles. */
const SYSTEM_LABEL_ROLES: Record<string, FolderRole> = {
  INBOX: 'inbox',
  CATEGORY_PROMOTIONS: 'promotions',
  CATEGORY_SOCIAL: 'social',
  CATEGORY_UPDATES: 'updates',
  CATEGORY_FORUMS: 'forums',
  SPAM: 'spam',
  TRASH: 'trash',
  DRAFT: 'drafts',
  SENT: 'sent',
  STARRED: 'starred',
  IMPORTANT: 'important',
};

/** Labels that are states rather than places — never offered as clean targets. */
const SKIP_LABELS = new Set(['UNREAD', 'CHAT', 'CATEGORY_PERSONAL']);

/** Gmail treats unquoted terms as OR'd words; quoting keeps phrases intact. */
const quote = (term: string): string => `"${term.replace(/"/g, '\\"')}"`;

export interface GmailNativeQuery {
  q: string;
  includeSpamTrash: boolean;
}

export class GmailProvider implements MailProvider {
  readonly id = 'gmail' as const;
  readonly capabilities: ProviderCapabilities;

  #bucket = new TokenBucket(250, 250);
  #labelCache: NormalizedFolder[] | null = null;

  constructor(
    readonly accountId: string,
    private readonly tokens: TokenSet,
  ) {
    const canPurge = grantsPermanentDelete(tokens.scope);
    this.capabilities = {
      serverSideKeywordSearch: true,
      searchesBody: true,
      permanentDelete: canPurge,
      restoreFromTrash: true,
      maxSearchResults: null,
      // batchModify and batchDelete both cap at 1000 ids per request.
      batchSize: 1000,
      supportsSizeFilter: true,
      supportsAttachmentFilter: true,
      supportsReadStateFilter: true,
      exactCounts: false,
    };
  }

  async #call<T>(req: Parameters<typeof apiFetch>[2], cost: number, signal?: AbortSignal): Promise<T> {
    await this.#bucket.take(cost, signal);
    return withRetry(() => apiFetch<T>('gmail', this.tokens.accessToken, { ...req, signal }), {
      label: 'gmail',
      signal,
      // Gmail's per-user limit is a moving average over roughly a minute, so a
      // handful of sub-second retries is not enough to clear it. Back off for
      // up to ~2 minutes before giving up on the job.
      attempts: 8,
      baseDelayMs: 1_000,
      maxDelayMs: 45_000,
    });
  }

  async verify(): Promise<{ email: string; displayName?: string | null }> {
    const profile = await this.#call<{ emailAddress: string }>({ url: `${API}/profile` }, QUOTA_GET);
    return { email: profile.emailAddress, displayName: null };
  }

  async listFolders(): Promise<NormalizedFolder[]> {
    if (this.#labelCache) return this.#labelCache;

    const { labels = [] } = await this.#call<{ labels: GmailLabel[] }>({ url: `${API}/labels` }, QUOTA_LIST);
    const usable = labels.filter((l) => !SKIP_LABELS.has(l.id));

    // labels.list omits counts; labels.get supplies them. Worth the extra calls
    // so a preview can say "Promotions: 12,480 messages" before anything runs.
    const detailed = await mapConcurrent(usable, 5, async (label) => {
      try {
        return await this.#call<GmailLabel>({ url: `${API}/labels/${encodeURIComponent(label.id)}` }, QUOTA_LABEL_GET);
      } catch {
        return label;
      }
    });

    this.#labelCache = detailed.map((label): NormalizedFolder => {
      const role = SYSTEM_LABEL_ROLES[label.id] ?? 'custom';
      return {
        remoteId: label.id,
        name: label.name,
        path: label.name,
        role,
        messageCount: label.messagesTotal ?? null,
        unreadCount: label.messagesUnread ?? null,
        isProtected: role === 'sent' || role === 'drafts' || role === 'starred' || role === 'important',
      };
    });
    return this.#labelCache;
  }

  compile(query: CleanQuery, folders: NormalizedFolder[]): CompiledQuery<GmailNativeQuery> {
    const terms: string[] = [];
    const notes: string[] = [];
    const residual: ResidualFilter = {};

    if (query.keywords.length > 0) {
      const quoted = query.keywords.map(quote);
      const scoped =
        query.keywordScope === 'subject'
          ? quoted.map((k) => `subject:${k}`)
          : query.keywordScope === 'from'
            ? quoted.map((k) => `from:${k}`)
            : query.keywordScope === 'subject_or_from'
              ? quoted.map((k) => `(subject:${k} OR from:${k})`)
              : quoted;
      terms.push(query.keywordMatch === 'all' ? scoped.join(' ') : `(${scoped.join(' OR ')})`);
    }

    for (const k of query.excludeKeywords) terms.push(`-${quote(k)}`);
    if (query.from.length > 0) terms.push(`(${query.from.map((f) => `from:${quote(f)}`).join(' OR ')})`);
    for (const f of query.excludeFrom) terms.push(`-from:${quote(f)}`);
    if (query.to.length > 0) terms.push(`(${query.to.map((t) => `to:${quote(t)}`).join(' OR ')})`);

    const window = resolveDateWindow(query);
    // Gmail interprets bare before:/after: dates as midnight PST. Using the
    // epoch-seconds form removes that ambiguity.
    if (window.before) terms.push(`before:${Math.floor(window.before.getTime() / 1000)}`);
    if (window.after) terms.push(`after:${Math.floor(window.after.getTime() / 1000)}`);

    if (query.largerThanBytes !== undefined) terms.push(`larger:${query.largerThanBytes}`);
    if (query.smallerThanBytes !== undefined) terms.push(`smaller:${query.smallerThanBytes}`);
    if (query.readState === 'unread') terms.push('is:unread');
    if (query.readState === 'read') terms.push('is:read');
    if (query.hasAttachment === true) terms.push('has:attachment');
    if (query.hasAttachment === false) terms.push('-has:attachment');
    if (query.excludeStarred) terms.push('-is:starred');
    if (query.excludeImportant) terms.push('-is:important');

    const includeSpamTrash = folders.some((f) => f.role === 'spam' || f.role === 'trash');
    if (includeSpamTrash) {
      notes.push('Spam and Trash are included explicitly because you selected those folders.');
    }
    notes.push('Gmail evaluates every filter server-side, including full-text body search.');

    return {
      native: { q: terms.join(' ').trim(), includeSpamTrash },
      folders,
      residual,
      notes,
    };
  }

  /**
   * Gmail ANDs multiple labelIds, but selected folders are an OR — so each
   * folder gets its own search pass. This also yields the per-folder breakdown
   * the preview shows.
   */
  async *search(compiled: CompiledQuery, opts: SearchOptions = {}): AsyncGenerator<MessageRef[]> {
    const native = compiled.native as GmailNativeQuery;
    let yielded = 0;

    for (const folder of compiled.folders) {
      let pageToken: string | undefined;
      do {
        if (opts.signal?.aborted) return;
        const url = new URL(`${API}/messages`);
        url.searchParams.set('maxResults', '500');
        url.searchParams.set('labelIds', folder.remoteId);
        if (native.q) url.searchParams.set('q', native.q);
        if (native.includeSpamTrash) url.searchParams.set('includeSpamTrash', 'true');
        if (pageToken) url.searchParams.set('pageToken', pageToken);

        const page = await this.#call<{ messages?: GmailMessageStub[]; nextPageToken?: string }>(
          { url: url.toString() },
          QUOTA_LIST,
          opts.signal,
        );

        const refs = (page.messages ?? []).map(
          (m): MessageRef => ({ id: m.id, folderRemoteId: folder.remoteId, threadId: m.threadId ?? null }),
        );
        if (refs.length > 0) {
          yielded += refs.length;
          opts.onProgress?.(yielded);
          yield opts.max && yielded > opts.max ? refs.slice(0, refs.length - (yielded - opts.max)) : refs;
          if (opts.max && yielded >= opts.max) return;
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    }
  }

  async hydrate(refs: MessageRef[], need: { body: boolean }): Promise<MessageRef[]> {
    const format = need.body ? 'full' : 'metadata';
    return mapConcurrent(refs, HYDRATE_CONCURRENCY, async (ref) => {
      try {
        const url = new URL(`${API}/messages/${encodeURIComponent(ref.id)}`);
        url.searchParams.set('format', format);
        if (!need.body) {
          for (const h of ['Subject', 'From', 'To', 'Date']) url.searchParams.append('metadataHeaders', h);
        }
        const msg = await this.#call<GmailMessage>({ url: url.toString() }, QUOTA_GET);
        return this.#toRef(msg, ref.folderRemoteId, need.body);
      } catch {
        // A message deleted between search and hydrate is not an error worth
        // failing the job over; drop it back unchanged so residual filtering
        // treats it as unproven and skips it.
        return ref;
      }
    });
  }

  #toRef(msg: GmailMessage, folderRemoteId: string | null, withBody: boolean): MessageRef {
    const headers = new Map(
      (msg.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value] as const),
    );
    const labels = new Set(msg.labelIds ?? []);
    return {
      id: msg.id,
      folderRemoteId,
      threadId: msg.threadId ?? null,
      subject: headers.get('subject') ?? null,
      from: headers.get('from') ?? null,
      to: headers.get('to') ?? null,
      sentAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
      sizeBytes: msg.sizeEstimate ?? null,
      isStarred: labels.has('STARRED'),
      isUnread: labels.has('UNREAD'),
      hasAttachment: hasAttachment(msg.payload),
      bodyText: withBody ? extractText(msg.payload) : (msg.snippet ?? null),
    };
  }

  async delete(refs: MessageRef[], mode: DeleteMode): Promise<BulkOutcome> {
    if (mode === 'permanent' && !this.capabilities.permanentDelete) {
      throw new ProviderError({
        provider: 'gmail',
        message:
          'Permanent delete needs the https://mail.google.com/ scope. Set GOOGLE_SCOPE_LEVEL=full, complete Google CASA verification, and have the user reconnect — or use mode "trash".',
        statusCode: 403,
        code: 'scope_insufficient',
      });
    }
    return this.#bulk(refs, (ids) =>
      mode === 'permanent'
        ? { url: `${API}/messages/batchDelete`, method: 'POST' as const, body: { ids }, empty: true }
        : {
            url: `${API}/messages/batchModify`,
            method: 'POST' as const,
            // Removing the category/inbox labels alongside adding TRASH matches
            // what the Gmail UI does, so the message leaves the folder cleanly.
            body: { ids, addLabelIds: ['TRASH'], removeLabelIds: ['INBOX', 'UNREAD'] },
            empty: true,
          },
    );
  }

  async restore(refs: MessageRef[]): Promise<BulkOutcome> {
    return this.#bulk(refs, (ids) => ({
      url: `${API}/messages/batchModify`,
      method: 'POST' as const,
      body: { ids, removeLabelIds: ['TRASH'], addLabelIds: ['INBOX'] },
      empty: true,
    }));
  }

  async #bulk(
    refs: MessageRef[],
    build: (ids: string[]) => Parameters<typeof apiFetch>[2],
  ): Promise<BulkOutcome> {
    const outcome: BulkOutcome = { succeeded: [], failed: [] };
    for (const batch of chunk(refs, this.capabilities.batchSize)) {
      const ids = batch.map((r) => r.id);
      try {
        await this.#call(build(ids), QUOTA_BATCH);
        outcome.succeeded.push(...ids);
      } catch (err) {
        const message = (err as Error).message;
        for (const id of ids) outcome.failed.push({ id, error: message });
      }
    }
    return outcome;
  }

  async close(): Promise<void> {
    // Stateless HTTP client; nothing to release.
  }
}

function hasAttachment(part: GmailPart | undefined): boolean {
  if (!part) return false;
  if (part.filename && part.filename.length > 0 && part.body?.attachmentId) return true;
  return (part.parts ?? []).some(hasAttachment);
}

/** Flattens text/plain and text/html parts so residual keyword matching works. */
function extractText(part: GmailPart | undefined, depth = 0): string {
  if (!part || depth > 8) return '';
  const own =
    part.body?.data && (part.mimeType ?? '').startsWith('text/')
      ? Buffer.from(part.body.data, 'base64url').toString('utf8')
      : '';
  const children = (part.parts ?? []).map((p) => extractText(p, depth + 1)).join(' ');
  return `${own} ${children}`.trim();
}
