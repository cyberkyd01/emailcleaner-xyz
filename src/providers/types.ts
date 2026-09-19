import type { ProviderId, DeleteMode } from '../db/types.js';

export type { ProviderId, DeleteMode };

/**
 * Every provider names its folders differently — Gmail has labels
 * (CATEGORY_PROMOTIONS), Outlook has well-known folder names (junkemail), IMAP
 * has SPECIAL-USE flags plus vendor-specific paths ("Bulk Mail" on Yahoo).
 * Rules are written against these roles, never against raw folder names.
 */
export type FolderRole =
  | 'inbox'
  | 'promotions'
  | 'social'
  | 'updates'
  | 'forums'
  | 'spam'
  | 'trash'
  | 'drafts'
  | 'sent'
  | 'archive'
  | 'starred'
  | 'important'
  | 'custom';

export const FOLDER_ROLES: readonly FolderRole[] = [
  'inbox', 'promotions', 'social', 'updates', 'forums', 'spam',
  'trash', 'drafts', 'sent', 'archive', 'starred', 'important', 'custom',
] as const;

/**
 * Deleting from these destroys mail the user authored or deliberately filed.
 * A rule must name them explicitly; "clean everything" never includes them.
 */
export const PROTECTED_ROLES: ReadonlySet<FolderRole> = new Set<FolderRole>([
  'sent', 'drafts', 'archive', 'starred', 'important',
]);

/** Roles that a "clean up my mailbox" default targets. */
export const DEFAULT_CLEANABLE_ROLES: readonly FolderRole[] = [
  'promotions', 'social', 'updates', 'forums', 'spam', 'trash',
] as const;

export interface NormalizedFolder {
  /** Provider-native id used in API calls (Gmail label id, Graph folder id, IMAP path). */
  remoteId: string;
  name: string;
  /** Full path as the user sees it, e.g. "INBOX/Receipts". */
  path: string;
  role: FolderRole;
  messageCount: number | null;
  unreadCount: number | null;
  /** True for PROTECTED_ROLES, or folders the user marked protected. */
  isProtected: boolean;
}

export interface MessageRef {
  /** Provider-native message id. For IMAP: "uidValidity:uid". */
  id: string;
  /** Folder the message was found in — required to restore it later. */
  folderRemoteId: string | null;
  threadId?: string | null;
  subject?: string | null;
  from?: string | null;
  to?: string | null;
  sentAt?: string | null;
  sizeBytes?: number | null;
  /** Set when the provider reports the message as flagged/starred. */
  isStarred?: boolean;
  isUnread?: boolean;
  hasAttachment?: boolean;
  /** Populated only by hydrate() when a residual keyword filter needs it. */
  bodyText?: string | null;
}

// ---------------------------------------------------------------------------
// The provider-agnostic query
// ---------------------------------------------------------------------------

export type KeywordScope = 'anywhere' | 'subject' | 'from' | 'subject_or_from';
export type ReadState = 'any' | 'read' | 'unread';

export interface CleanQuery {
  /**
   * Folder roles and/or explicit "folder:REMOTE_ID" selectors.
   * Empty means every non-protected folder.
   */
  folders: string[];
  /** Match any/all of these within keywordScope. This is the keyword feature. */
  keywords: string[];
  keywordMatch: 'any' | 'all';
  keywordScope: KeywordScope;
  from: string[];
  to: string[];
  /** Relative age filters — the usual way users express "old mail". */
  olderThanDays?: number | undefined;
  newerThanDays?: number | undefined;
  /** Absolute bounds (ISO date), applied in addition to the relative ones. */
  before?: string | undefined;
  after?: string | undefined;
  largerThanBytes?: number | undefined;
  smallerThanBytes?: number | undefined;
  readState: ReadState;
  hasAttachment?: boolean | undefined;
  /** Safety negations. Starred/flagged mail is excluded unless opted out. */
  excludeStarred: boolean;
  excludeImportant: boolean;
  excludeKeywords: string[];
  excludeFrom: string[];
  /** Hard cap on how many messages this query may act on. */
  limit?: number | undefined;
}

export const emptyQuery = (): CleanQuery => ({
  folders: [],
  keywords: [],
  keywordMatch: 'any',
  keywordScope: 'anywhere',
  from: [],
  to: [],
  readState: 'any',
  excludeStarred: true,
  excludeImportant: true,
  excludeKeywords: [],
  excludeFrom: [],
});

/**
 * Filters the provider could not push server-side. The engine applies these to
 * every candidate before deleting, so a weaker backend never over-deletes — it
 * only costs extra fetches.
 */
export interface ResidualFilter {
  keywords?: { terms: string[]; match: 'any' | 'all'; scope: KeywordScope };
  excludeKeywords?: string[];
  from?: string[];
  excludeFrom?: string[];
  to?: string[];
  sentAfter?: string;
  sentBefore?: string;
  minBytes?: number;
  maxBytes?: number;
  readState?: ReadState;
  hasAttachment?: boolean;
  excludeStarred?: boolean;
  /** Residual keyword matching needs the body, which costs an extra fetch. */
  requiresBody?: boolean;
}

export interface CompiledQuery<TNative = unknown> {
  /** Provider-native query (Gmail q string, Graph request spec, IMAP criteria). */
  native: TNative;
  /** Folders to run the native query against. */
  folders: NormalizedFolder[];
  residual: ResidualFilter;
  /**
   * Plain-language notes rendered in the preview, e.g. "Outlook cannot combine
   * keyword search with a date filter; dates are applied locally."
   */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface ProviderCapabilities {
  /** Server can filter by keyword (vs. us downloading and matching locally). */
  serverSideKeywordSearch: boolean;
  /** Server-side keyword search covers the body, not just headers. */
  searchesBody: boolean;
  /** Supports deleting without passing through Trash. */
  permanentDelete: boolean;
  /** Trashed messages can be moved back by this adapter (enables undo). */
  restoreFromTrash: boolean;
  /** Search result ceiling per query, if the API caps it (Graph: 1000). */
  maxSearchResults: number | null;
  /** How many ids one delete call accepts. */
  batchSize: number;
  supportsSizeFilter: boolean;
  supportsAttachmentFilter: boolean;
  supportsReadStateFilter: boolean;
  /** Server reports an exact match count without enumerating. */
  exactCounts: boolean;
}

// ---------------------------------------------------------------------------
// The adapter contract
// ---------------------------------------------------------------------------

export interface BulkOutcome {
  succeeded: string[];
  failed: Array<{ id: string; error: string }>;
}

export interface SearchOptions {
  signal?: AbortSignal;
  /** Stop enumerating once this many candidates have been yielded. */
  max?: number;
  /** Called with a running total so long previews can report progress. */
  onProgress?: (seen: number) => void;
}

/**
 * One instance per (account, operation). Adapters own their connection and must
 * be closed. Implementations may assume single-threaded use.
 */
export interface MailProvider {
  readonly id: ProviderId;
  readonly accountId: string;
  readonly capabilities: ProviderCapabilities;

  /** Confirms the credential works and returns the mailbox identity. */
  verify(): Promise<{ email: string; displayName?: string | null }>;

  listFolders(): Promise<NormalizedFolder[]>;

  compile(query: CleanQuery, folders: NormalizedFolder[]): CompiledQuery;

  /** Yields candidate messages in pages. Residual filtering happens upstream. */
  search(compiled: CompiledQuery, opts?: SearchOptions): AsyncGenerator<MessageRef[]>;

  /**
   * Fetches the fields a residual filter needs (body text, flags, size) for
   * refs the search could not fully describe.
   */
  hydrate(refs: MessageRef[], need: { body: boolean }): Promise<MessageRef[]>;

  delete(refs: MessageRef[], mode: DeleteMode): Promise<BulkOutcome>;

  /** Moves trashed messages back. Only called when mode was 'trash'. */
  restore(refs: MessageRef[]): Promise<BulkOutcome>;

  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Provider catalogue (drives the connect UI and the setup docs)
// ---------------------------------------------------------------------------

export interface SetupStep {
  title: string;
  detail: string;
  /** Deep link to the console/settings page where the step happens. */
  link?: string;
}

export interface ProviderDescriptor {
  id: ProviderId;
  /** Shown in the picker. "imap" covers Yahoo, Mail.com, GMX, Zoho, iCloud... */
  label: string;
  description: string;
  authType: 'oauth2' | 'password';
  /** False when this deployment has not configured the provider credentials. */
  available: boolean;
  unavailableReason?: string;
  /** What the operator must do once, before anyone can connect. */
  operatorSetup: SetupStep[];
  /** What each end user must do when connecting their mailbox. */
  userSetup: SetupStep[];
  /** Caveats worth showing next to the connect button. */
  notes: string[];
  docsPath: string;
}
