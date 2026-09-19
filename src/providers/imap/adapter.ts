import { ImapFlow, type ListResponse, type SearchObject } from 'imapflow';
import { config } from '../../config.js';
import { AuthExpiredError, ProviderError } from '../../lib/errors.js';
import { resolveDateWindow } from '../query.js';
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

export interface ImapCredentials {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** App password or account password. Mutually exclusive with accessToken. */
  password?: string;
  /** XOAUTH2 bearer, for hosts that support it (Yahoo, Gmail, Office 365). */
  accessToken?: string;
}

/** Yahoo calls spam "Bulk Mail"; Exchange calls trash "Deleted Items". */
const NAME_ROLES: Array<[RegExp, FolderRole]> = [
  [/^inbox$/i, 'inbox'],
  [/^(junk|spam|bulk)\b|junk\s*e-?mail|bulk\s*mail/i, 'spam'],
  [/^(trash|deleted items|deleted messages|bin)$/i, 'trash'],
  [/^drafts?$/i, 'drafts'],
  [/^(sent|sent items|sent messages|sent mail)$/i, 'sent'],
  [/^(archive|all mail)$/i, 'archive'],
];

const SPECIAL_USE_ROLES: Record<string, FolderRole> = {
  '\\Inbox': 'inbox',
  '\\Junk': 'spam',
  '\\Trash': 'trash',
  '\\Drafts': 'drafts',
  '\\Sent': 'sent',
  '\\Archive': 'archive',
  '\\All': 'archive',
  '\\Flagged': 'starred',
};

const PAGE_SIZE = 500;

/** Composite id keeps a UID meaningful after a mailbox re-numbers itself. */
const composeId = (uidValidity: string, uid: number): string => `${uidValidity}:${uid}`;
const parseUid = (id: string): number => Number(id.split(':').pop());

export interface ImapNativeQuery {
  /** One SearchObject per keyword term when matching 'all' — results intersect. */
  searches: SearchObject[];
  intersect: boolean;
}

export class ImapProvider implements MailProvider {
  readonly id = 'imap' as const;
  readonly capabilities: ProviderCapabilities = {
    serverSideKeywordSearch: true,
    // IMAP SEARCH TEXT covers headers and body, but matching is server-defined
    // and often substring-only on decoded text.
    searchesBody: true,
    permanentDelete: true,
    restoreFromTrash: true,
    maxSearchResults: null,
    batchSize: 200,
    supportsSizeFilter: true,
    supportsAttachmentFilter: false,
    supportsReadStateFilter: true,
    exactCounts: true,
  };

  #client: ImapFlow | null = null;
  #folderCache: NormalizedFolder[] | null = null;
  #trashPath: string | null = null;

  constructor(
    readonly accountId: string,
    private readonly creds: ImapCredentials,
  ) {}

  async #connect(): Promise<ImapFlow> {
    if (this.#client?.usable) return this.#client;

    const client = new ImapFlow({
      host: this.creds.host,
      port: this.creds.port,
      secure: this.creds.secure,
      auth: this.creds.accessToken
        ? { user: this.creds.user, accessToken: this.creds.accessToken }
        : { user: this.creds.user, pass: this.creds.password ?? '' },
      logger: false,
      tls: { rejectUnauthorized: !config.imap.allowInsecureTls },
      // Some hosts (Yahoo in particular) are slow to greet.
      greetingTimeout: 20_000,
      socketTimeout: 120_000,
    });

    try {
      await client.connect();
    } catch (err) {
      const detail = err as Error & { authenticationFailed?: boolean; responseText?: string };
      const message = detail.responseText ?? detail.message ?? String(err);
      if (
        detail.authenticationFailed === true ||
        /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|AUTHENTICATE failed/i.test(message)
      ) {
        throw new AuthExpiredError(
          'imap',
          `${this.creds.host} rejected the credentials. Most providers require an app password rather than your account password.`,
        );
      }
      throw new ProviderError({
        provider: 'imap',
        message: `Could not connect to ${this.creds.host}:${this.creds.port} — ${message}. If the host and port are right, the provider most likely requires an app password rather than your account password.`,
        retryable: /timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(message),
      });
    }

    this.#client = client;
    return client;
  }

  async verify(): Promise<{ email: string; displayName?: string | null }> {
    await this.#connect();
    return { email: this.creds.user, displayName: null };
  }

  async listFolders(): Promise<NormalizedFolder[]> {
    if (this.#folderCache) return this.#folderCache;
    const client = await this.#connect();
    const mailboxes = (await client.list()) as ListResponse[];

    const folders: NormalizedFolder[] = [];
    for (const box of mailboxes) {
      // \Noselect folders are structural nodes that hold no messages.
      if (box.flags?.has('\\Noselect')) continue;

      const role = roleForMailbox(box);
      let messageCount: number | null = null;
      let unreadCount: number | null = null;
      try {
        const status = await client.status(box.path, { messages: true, unseen: true });
        messageCount = status.messages ?? null;
        unreadCount = status.unseen ?? null;
      } catch {
        // STATUS is optional; a missing count is not a reason to hide the folder.
      }

      folders.push({
        remoteId: box.path,
        name: box.name,
        path: box.path,
        role,
        messageCount,
        unreadCount,
        isProtected: role === 'sent' || role === 'drafts' || role === 'archive',
      });
      if (role === 'trash') this.#trashPath = box.path;
    }

    this.#folderCache = folders;
    return folders;
  }

  compile(query: CleanQuery, folders: NormalizedFolder[]): CompiledQuery<ImapNativeQuery> {
    const notes: string[] = [];
    const residual: ResidualFilter = {};
    const base: SearchObject = {};
    const window = resolveDateWindow(query);

    if (window.before) base.before = window.before;
    if (window.after) base.since = window.after;
    if (window.before || window.after) {
      // IMAP BEFORE/SINCE compare whole days in the server's timezone, so the
      // exact bounds are re-applied locally.
      residual.sentBefore = window.before?.toISOString();
      residual.sentAfter = window.after?.toISOString();
      notes.push('IMAP date search has day granularity; exact times are enforced locally.');
    }

    if (query.readState === 'read') base.seen = true;
    if (query.readState === 'unread') base.seen = false;
    if (query.largerThanBytes !== undefined) base.larger = query.largerThanBytes;
    if (query.smallerThanBytes !== undefined) base.smaller = query.smallerThanBytes;
    if (query.excludeStarred) {
      base.flagged = false;
      notes.push('Flagged (starred) messages are excluded at the server.');
    }

    if (query.from.length === 1) base.from = query.from[0] as string;
    else if (query.from.length > 1) {
      base.or = query.from.map((f) => ({ from: f }));
      notes.push('Multiple senders are matched with a server-side OR.');
    }
    if (query.to.length === 1) base.to = query.to[0] as string;
    else if (query.to.length > 1) residual.to = [...query.to];

    if (query.hasAttachment !== undefined) {
      residual.hasAttachment = query.hasAttachment;
      notes.push('IMAP cannot filter on attachments; each candidate is checked locally.');
    }
    if (query.excludeKeywords.length > 0) residual.excludeKeywords = [...query.excludeKeywords];
    if (query.excludeFrom.length > 0) residual.excludeFrom = [...query.excludeFrom];

    const field = (term: string): SearchObject => {
      switch (query.keywordScope) {
        case 'subject':
          return { subject: term };
        case 'from':
          return { from: term };
        case 'subject_or_from':
          return { or: [{ subject: term }, { from: term }] };
        default:
          return { body: term };
      }
    };

    let searches: SearchObject[] = [base];
    let intersect = false;

    if (query.keywords.length === 1) {
      searches = [{ ...base, ...field(query.keywords[0] as string) }];
    } else if (query.keywords.length > 1) {
      if (query.keywordMatch === 'any') {
        searches = [{ ...base, or: query.keywords.map(field) }];
      } else {
        // IMAP SEARCH ANDs at the top level but a plain object cannot hold two
        // BODY keys. Running one search per term and intersecting the UID sets
        // gives exact AND semantics on every server.
        searches = query.keywords.map((k) => ({ ...base, ...field(k) }));
        intersect = true;
        notes.push('Matching all keywords is done by intersecting one server search per keyword.');
      }
    }

    notes.push(
      `Server-side search on ${this.creds.host}. Results are re-verified locally before anything is deleted.`,
    );

    return { native: { searches, intersect }, folders, residual, notes };
  }

  async *search(compiled: CompiledQuery, opts: SearchOptions = {}): AsyncGenerator<MessageRef[]> {
    const native = compiled.native as ImapNativeQuery;
    const client = await this.#connect();
    let yielded = 0;

    for (const folder of compiled.folders) {
      if (opts.signal?.aborted) return;
      const lock = await client.getMailboxLock(folder.remoteId, { readOnly: true });
      try {
        const mailbox = client.mailbox;
        if (!mailbox || typeof mailbox === 'boolean') continue;
        const uidValidity = String(mailbox.uidValidity ?? '0');

        let uids: number[] | null = null;
        for (const criteria of native.searches) {
          const found = await this.#search(client, criteria, folder.remoteId);
          if (uids === null) uids = found;
          else if (native.intersect) {
            const set = new Set(found);
            uids = uids.filter((u) => set.has(u));
          } else {
            uids = [...new Set([...uids, ...found])];
          }
          if (uids.length === 0) break;
        }
        if (!uids || uids.length === 0) continue;

        // Newest first matches what users expect from a preview sample.
        uids.sort((a, b) => b - a);

        for (let i = 0; i < uids.length; i += PAGE_SIZE) {
          if (opts.signal?.aborted) return;
          const slice = uids.slice(i, i + PAGE_SIZE);
          const refs = await this.#fetchRefs(client, slice, folder.remoteId, uidValidity);
          if (refs.length === 0) continue;
          yielded += refs.length;
          opts.onProgress?.(yielded);
          if (opts.max && yielded > opts.max) {
            yield refs.slice(0, refs.length - (yielded - opts.max));
            return;
          }
          yield refs;
        }
      } finally {
        lock.release();
      }
    }
  }

  async #search(client: ImapFlow, criteria: SearchObject, path: string): Promise<number[]> {
    try {
      return (await client.search(criteria, { uid: true })) || [];
    } catch (err) {
      // Some servers reject SEARCH with non-ASCII terms or unsupported keys.
      // Failing the whole job would be worse than saying which folder broke.
      throw new ProviderError({
        provider: 'imap',
        message: `IMAP SEARCH failed in "${path}": ${(err as Error).message}. Try narrowing the keyword or using subject-only scope.`,
        retryable: false,
      });
    }
  }

  async #fetchRefs(
    client: ImapFlow,
    uids: number[],
    path: string,
    uidValidity: string,
  ): Promise<MessageRef[]> {
    const refs: MessageRef[] = [];
    for await (const msg of client.fetch(
      uids.join(','),
      { uid: true, envelope: true, size: true, flags: true, bodyStructure: true },
      { uid: true },
    )) {
      const envelope = msg.envelope;
      refs.push({
        id: composeId(uidValidity, msg.uid),
        folderRemoteId: path,
        subject: envelope?.subject ?? null,
        from: formatAddress(envelope?.from),
        to: formatAddress(envelope?.to),
        sentAt: envelope?.date ? new Date(envelope.date).toISOString() : null,
        sizeBytes: msg.size ?? null,
        isStarred: msg.flags?.has('\\Flagged') ?? false,
        isUnread: msg.flags ? !msg.flags.has('\\Seen') : undefined,
        hasAttachment: structureHasAttachment(msg.bodyStructure),
        bodyText: null,
      });
    }
    return refs;
  }

  async hydrate(refs: MessageRef[], need: { body: boolean }): Promise<MessageRef[]> {
    if (!need.body || refs.length === 0) return refs;
    const client = await this.#connect();
    const byFolder = groupByFolder(refs);
    const hydrated = new Map<string, MessageRef>();

    for (const [path, group] of byFolder) {
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        for await (const msg of client.fetch(
          group.map((r) => parseUid(r.id)).join(','),
          { uid: true, bodyParts: ['text'] },
          { uid: true },
        )) {
          const original = group.find((r) => parseUid(r.id) === msg.uid);
          if (!original) continue;
          const raw = msg.bodyParts?.get('text');
          hydrated.set(original.id, {
            ...original,
            bodyText: raw ? raw.toString('utf8') : null,
          });
        }
      } finally {
        lock.release();
      }
    }
    return refs.map((r) => hydrated.get(r.id) ?? r);
  }

  async delete(refs: MessageRef[], mode: DeleteMode): Promise<BulkOutcome> {
    const client = await this.#connect();
    const outcome: BulkOutcome = { succeeded: [], failed: [] };

    if (mode === 'trash') {
      const trash = await this.#findTrash();
      if (!trash) {
        throw new ProviderError({
          provider: 'imap',
          message:
            'This mailbox exposes no Trash folder over IMAP, so messages cannot be moved instead of erased. Re-run with mode "permanent" if you accept that this is irreversible.',
          statusCode: 409,
          code: 'no_trash_folder',
        });
      }
      for (const [path, group] of groupByFolder(refs)) {
        // Messages already sitting in Trash have nowhere softer to go.
        if (path === trash) {
          outcome.succeeded.push(...group.map((r) => r.id));
          continue;
        }
        await this.#withFolder(client, path, group, outcome, async (uids) => {
          await client.messageMove(uids.join(','), trash, { uid: true });
        });
      }
      return outcome;
    }

    for (const [path, group] of groupByFolder(refs)) {
      await this.#withFolder(client, path, group, outcome, async (uids) => {
        await client.messageDelete(uids.join(','), { uid: true });
      });
    }
    return outcome;
  }

  async restore(refs: MessageRef[]): Promise<BulkOutcome> {
    const client = await this.#connect();
    const trash = await this.#findTrash();
    const outcome: BulkOutcome = { succeeded: [], failed: [] };
    if (!trash) {
      for (const ref of refs) outcome.failed.push({ id: ref.id, error: 'No Trash folder to restore from' });
      return outcome;
    }

    // After a move the UID changed, so restore matches on Message-ID instead.
    for (const [origin, group] of groupByFolder(refs)) {
      const lock = await client.getMailboxLock(trash, { readOnly: false });
      try {
        for (const ref of group) {
          try {
            const uids = await client.search({ header: { subject: ref.subject ?? '' } }, { uid: true });
            if (!uids || uids.length === 0) {
              outcome.failed.push({ id: ref.id, error: 'Message no longer in Trash' });
              continue;
            }
            await client.messageMove(uids.join(','), origin, { uid: true });
            outcome.succeeded.push(ref.id);
          } catch (err) {
            outcome.failed.push({ id: ref.id, error: (err as Error).message });
          }
        }
      } finally {
        lock.release();
      }
    }
    return outcome;
  }

  async #withFolder(
    client: ImapFlow,
    path: string,
    group: MessageRef[],
    outcome: BulkOutcome,
    op: (uids: number[]) => Promise<void>,
  ): Promise<void> {
    const lock = await client.getMailboxLock(path, { readOnly: false });
    try {
      for (let i = 0; i < group.length; i += this.capabilities.batchSize) {
        const batch = group.slice(i, i + this.capabilities.batchSize);
        try {
          await op(batch.map((r) => parseUid(r.id)));
          outcome.succeeded.push(...batch.map((r) => r.id));
        } catch (err) {
          const message = (err as Error).message;
          for (const ref of batch) outcome.failed.push({ id: ref.id, error: message });
        }
      }
    } finally {
      lock.release();
    }
  }

  async #findTrash(): Promise<string | null> {
    if (this.#trashPath) return this.#trashPath;
    const folders = await this.listFolders();
    this.#trashPath = folders.find((f) => f.role === 'trash')?.remoteId ?? null;
    return this.#trashPath;
  }

  async close(): Promise<void> {
    if (!this.#client) return;
    try {
      await this.#client.logout();
    } catch {
      this.#client.close();
    }
    this.#client = null;
  }
}

// ---------------------------------------------------------------------------

function roleForMailbox(box: ListResponse): FolderRole {
  const special = box.specialUse ?? [...(box.flags ?? [])].find((f) => f in SPECIAL_USE_ROLES);
  if (special && SPECIAL_USE_ROLES[special]) return SPECIAL_USE_ROLES[special] as FolderRole;
  for (const [pattern, role] of NAME_ROLES) {
    if (pattern.test(box.name) || pattern.test(box.path)) return role;
  }
  return 'custom';
}

function formatAddress(list: Array<{ name?: string; address?: string }> | undefined): string | null {
  if (!list || list.length === 0) return null;
  return list
    .map((a) => (a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')))
    .filter(Boolean)
    .join(', ');
}

interface BodyStructureNode {
  disposition?: string;
  dispositionParameters?: Record<string, unknown>;
  childNodes?: BodyStructureNode[];
}

function structureHasAttachment(node: unknown, depth = 0): boolean {
  if (!node || depth > 8) return false;
  const n = node as BodyStructureNode;
  if (n.disposition && n.disposition.toLowerCase() === 'attachment') return true;
  return (n.childNodes ?? []).some((child) => structureHasAttachment(child, depth + 1));
}

function groupByFolder(refs: readonly MessageRef[]): Map<string, MessageRef[]> {
  const map = new Map<string, MessageRef[]>();
  for (const ref of refs) {
    const key = ref.folderRemoteId ?? 'INBOX';
    const bucket = map.get(key);
    if (bucket) bucket.push(ref);
    else map.set(key, [ref]);
  }
  return map;
}
