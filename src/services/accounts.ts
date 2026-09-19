import { getDb, nowIso } from '../db/index.js';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { newId } from '../lib/ids.js';
import { logger } from '../lib/logger.js';
import { AuthExpiredError, badRequest, notFound } from '../lib/errors.js';
import { refreshTokens, tokenIsStale, type TokenSet } from '../providers/oauth.js';
import { GMAIL_ENDPOINTS, gmailScopes } from '../providers/gmail/auth.js';
import { microsoftEndpoints, MICROSOFT_SCOPES } from '../providers/microsoft/auth.js';
import { GmailProvider } from '../providers/gmail/adapter.js';
import { MicrosoftProvider } from '../providers/microsoft/adapter.js';
import { ImapProvider, type ImapCredentials } from '../providers/imap/adapter.js';
import { config } from '../config.js';
import { audit } from './audit.js';
import type { AccountTable, ProviderId } from '../db/types.js';
import type { MailProvider, NormalizedFolder } from '../providers/types.js';

export type StoredSecret =
  | { kind: 'oauth2'; tokens: TokenSet }
  | { kind: 'imap'; credentials: ImapCredentials };

/** Per-account rules that override anything a job asks for. */
export interface AccountProtections {
  /** Folder remoteIds that may never be cleaned, whatever a rule says. */
  folders: string[];
  /** Senders whose mail is always kept. */
  senders: string[];
  /** Keywords that veto a match. */
  keywords: string[];
}

export const defaultProtections = (): AccountProtections => ({ folders: [], senders: [], keywords: [] });

export interface AccountView {
  id: string;
  provider: ProviderId;
  authType: string;
  email: string;
  displayName: string | null;
  status: string;
  statusDetail: string | null;
  protections: AccountProtections;
  settings: Record<string, unknown>;
  lastConnectedAt: string | null;
  createdAt: string;
  capabilities?: Record<string, unknown>;
}

export const toAccountView = (row: AccountTable): AccountView => ({
  id: row.id,
  provider: row.provider,
  authType: row.auth_type,
  email: row.email,
  displayName: row.display_name,
  status: row.status,
  statusDetail: row.status_detail,
  protections: { ...defaultProtections(), ...(JSON.parse(row.protections_json) as Partial<AccountProtections>) },
  settings: JSON.parse(row.settings_json) as Record<string, unknown>,
  lastConnectedAt: row.last_connected_at,
  createdAt: row.created_at,
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function listAccounts(userId: string): Promise<AccountView[]> {
  const db = await getDb();
  const rows = await db.selectFrom('accounts').selectAll().where('user_id', '=', userId).orderBy('created_at').execute();
  return rows.map(toAccountView);
}

export async function getAccountRow(userId: string, accountId: string): Promise<AccountTable> {
  const db = await getDb();
  const row = await db
    .selectFrom('accounts')
    .selectAll()
    .where('id', '=', accountId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row) throw notFound('Account');
  return row;
}

export interface UpsertAccountInput {
  userId: string;
  provider: ProviderId;
  authType: 'oauth2' | 'password';
  email: string;
  displayName?: string | null;
  secret: StoredSecret;
  scopes?: string | null;
  settings?: Record<string, unknown>;
}

/**
 * Reconnecting an existing mailbox updates the credential in place, so job
 * history and rules survive a re-auth.
 */
export async function upsertAccount(input: UpsertAccountInput): Promise<AccountView> {
  const db = await getDb();
  const existing = await db
    .selectFrom('accounts')
    .selectAll()
    .where('user_id', '=', input.userId)
    .where('provider', '=', input.provider)
    .where('email', '=', input.email)
    .executeTakeFirst();

  const id = existing?.id ?? newId('acc');
  const now = nowIso();
  // The account id is bound into the ciphertext, so a secret copied into
  // another row fails authentication rather than decrypting.
  const secretEnc = encryptJson(input.secret, id);

  if (existing) {
    await db
      .updateTable('accounts')
      .set({
        auth_type: input.authType,
        display_name: input.displayName ?? existing.display_name,
        secret_enc: secretEnc,
        scopes: input.scopes ?? existing.scopes,
        settings_json: JSON.stringify({ ...JSON.parse(existing.settings_json), ...(input.settings ?? {}) }),
        status: 'active',
        status_detail: null,
        last_connected_at: now,
        updated_at: now,
      })
      .where('id', '=', id)
      .execute();
  } else {
    await db
      .insertInto('accounts')
      .values({
        id,
        user_id: input.userId,
        provider: input.provider,
        auth_type: input.authType,
        email: input.email,
        display_name: input.displayName ?? null,
        status: 'active',
        status_detail: null,
        secret_enc: secretEnc,
        scopes: input.scopes ?? null,
        settings_json: JSON.stringify(input.settings ?? {}),
        protections_json: JSON.stringify(defaultProtections()),
        last_connected_at: now,
        last_error_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  await audit({
    userId: input.userId,
    accountId: id,
    action: existing ? 'account.reconnected' : 'account.connected',
    detail: { provider: input.provider, email: input.email },
  });

  return toAccountView(await getAccountRow(input.userId, id));
}

export async function deleteAccount(userId: string, accountId: string): Promise<void> {
  const db = await getDb();
  const row = await getAccountRow(userId, accountId);
  await db.deleteFrom('accounts').where('id', '=', accountId).where('user_id', '=', userId).execute();
  await audit({ userId, accountId, action: 'account.deleted', detail: { provider: row.provider, email: row.email } });
}

export async function updateProtections(
  userId: string,
  accountId: string,
  protections: AccountProtections,
): Promise<AccountView> {
  const db = await getDb();
  await getAccountRow(userId, accountId);
  await db
    .updateTable('accounts')
    .set({ protections_json: JSON.stringify(protections), updated_at: nowIso() })
    .where('id', '=', accountId)
    .execute();
  await audit({ userId, accountId, action: 'account.protections_updated', detail: { ...protections } });
  return toAccountView(await getAccountRow(userId, accountId));
}

async function markAccountStatus(
  accountId: string,
  status: 'active' | 'needs_reauth' | 'error',
  detail: string | null,
): Promise<void> {
  const db = await getDb();
  await db
    .updateTable('accounts')
    .set({
      status,
      status_detail: detail,
      last_error_at: status === 'active' ? null : nowIso(),
      updated_at: nowIso(),
    })
    .where('id', '=', accountId)
    .execute();
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/**
 * Builds a live provider adapter for a stored account, refreshing OAuth tokens
 * first and persisting the refreshed set so the next call starts warm.
 *
 * Callers must close() the returned adapter — IMAP holds a real socket.
 */
export async function openProvider(userId: string, accountId: string): Promise<MailProvider> {
  const row = await getAccountRow(userId, accountId);
  if (row.status === 'disabled') {
    throw badRequest('This account is disabled. Re-enable it before running a clean.');
  }

  const secret = decryptJson<StoredSecret>(row.secret_enc, row.id);

  try {
    if (secret.kind === 'imap') {
      return new ImapProvider(row.id, secret.credentials);
    }

    const tokens = await ensureFreshTokens(row, secret.tokens);
    if (row.provider === 'gmail') return new GmailProvider(row.id, tokens);
    if (row.provider === 'microsoft') return new MicrosoftProvider(row.id, tokens);
    throw badRequest(`Provider "${row.provider}" has no OAuth adapter`);
  } catch (err) {
    if (err instanceof AuthExpiredError) {
      await markAccountStatus(row.id, 'needs_reauth', err.message);
    }
    throw err;
  }
}

async function ensureFreshTokens(row: AccountTable, tokens: TokenSet): Promise<TokenSet> {
  if (!tokenIsStale(tokens)) return tokens;

  const refreshed =
    row.provider === 'gmail'
      ? await refreshTokens({
          provider: 'gmail',
          endpoints: GMAIL_ENDPOINTS,
          clientId: config.google.clientId as string,
          clientSecret: config.google.clientSecret,
          tokens,
          scope: gmailScopes().join(' '),
        })
      : await refreshTokens({
          provider: 'microsoft',
          endpoints: microsoftEndpoints(),
          clientId: config.microsoft.clientId as string,
          clientSecret: config.microsoft.clientSecret,
          tokens,
          scope: MICROSOFT_SCOPES.join(' '),
        });

  const db = await getDb();
  await db
    .updateTable('accounts')
    .set({
      secret_enc: encryptJson({ kind: 'oauth2', tokens: refreshed } satisfies StoredSecret, row.id),
      scopes: refreshed.scope ?? row.scopes,
      status: 'active',
      status_detail: null,
      updated_at: nowIso(),
    })
    .where('id', '=', row.id)
    .execute();

  logger.debug('refreshed oauth tokens', { accountId: row.id, provider: row.provider });
  return refreshed;
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

/** Reads folders from the provider and caches them for the rule editor. */
export async function refreshFolders(userId: string, accountId: string): Promise<NormalizedFolder[]> {
  const provider = await openProvider(userId, accountId);
  try {
    const folders = await provider.listFolders();
    const db = await getDb();
    const now = nowIso();

    await db.deleteFrom('folders').where('account_id', '=', accountId).execute();
    if (folders.length > 0) {
      await db
        .insertInto('folders')
        .values(
          folders.map((f) => ({
            id: newId('fld'),
            account_id: accountId,
            remote_id: f.remoteId,
            name: f.name,
            path: f.path,
            role: f.role,
            message_count: f.messageCount,
            unread_count: f.unreadCount,
            is_protected: f.isProtected ? 1 : 0,
            refreshed_at: now,
          })),
        )
        .execute();
    }
    await markAccountStatus(accountId, 'active', null);
    return folders;
  } finally {
    await provider.close();
  }
}

/** Cached folders, refreshing on a cold cache so callers always get a list. */
export async function getFolders(userId: string, accountId: string, forceRefresh = false): Promise<NormalizedFolder[]> {
  await getAccountRow(userId, accountId);
  if (forceRefresh) return refreshFolders(userId, accountId);

  const db = await getDb();
  const rows = await db.selectFrom('folders').selectAll().where('account_id', '=', accountId).execute();
  if (rows.length === 0) return refreshFolders(userId, accountId);

  return rows.map((r) => ({
    remoteId: r.remote_id,
    name: r.name,
    path: r.path,
    role: r.role as NormalizedFolder['role'],
    messageCount: r.message_count,
    unreadCount: r.unread_count,
    isProtected: r.is_protected === 1,
  }));
}

/** Folders the account owner has pinned as never-clean. */
export async function getAccountProtections(userId: string, accountId: string): Promise<AccountProtections> {
  const row = await getAccountRow(userId, accountId);
  return { ...defaultProtections(), ...(JSON.parse(row.protections_json) as Partial<AccountProtections>) };
}
