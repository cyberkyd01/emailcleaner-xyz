import type { Generated } from 'kysely';

/**
 * Storage conventions chosen so one schema runs on both SQLite and Postgres:
 *  - timestamps are ISO-8601 UTC strings
 *  - booleans are INTEGER 0/1
 *  - structured values are JSON strings
 */

export type ProviderId = 'gmail' | 'microsoft' | 'imap';
export type AuthType = 'oauth2' | 'password';
export type AccountStatus = 'active' | 'needs_reauth' | 'error' | 'disabled';

export type JobStatus =
  | 'queued'          // waiting for a worker to pick up the preview
  | 'previewing'      // counting matches, no mutation yet
  | 'awaiting_confirm'// preview done, waiting for the user to approve
  | 'queued_execute'  // confirmed, waiting for a worker
  | 'running'         // deleting
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'undoing'
  | 'undone';

/** 'trash' is reversible; 'permanent' is not. */
export type DeleteMode = 'trash' | 'permanent';

export type JobItemState = 'matched' | 'deleted' | 'failed' | 'restored' | 'skipped';

export type PlanId = 'free' | 'pro' | 'business';
export type UserStatus = 'active' | 'suspended';

export interface UserTable {
  id: string;
  email: string;
  password_hash: string;
  is_admin: number;
  created_at: string;
  updated_at: string;
  /** AES-256-GCM blob holding the base32 TOTP secret, bound to the user id. */
  totp_secret_enc: string | null;
  totp_enabled: number;
  totp_confirmed_at: string | null;
  /** JSON array of { hash, usedAt } recovery codes. */
  backup_codes_json: string | null;
  display_name: string | null;
  plan: PlanId;
  plan_started_at: string | null;
  status: UserStatus;
  last_login_at: string | null;
  last_seen_at: string | null;
  login_count: number;
  accepted_terms_at: string | null;
}

export interface MfaChallengeTable {
  id: string;
  user_id: string;
  attempts: number;
  ip: string | null;
  created_at: string;
  expires_at: string;
}

export interface LoginAttemptTable {
  id: Generated<number>;
  identifier: string;
  ip: string | null;
  success: number;
  created_at: string;
}

export interface AccountTable {
  id: string;
  user_id: string;
  provider: ProviderId;
  auth_type: AuthType;
  email: string;
  display_name: string | null;
  status: AccountStatus;
  status_detail: string | null;
  /** AES-256-GCM blob: OAuth token set, or IMAP connection settings + password. */
  secret_enc: string;
  scopes: string | null;
  /** Non-secret provider settings (IMAP host/port, tenant, capability flags). */
  settings_json: string;
  /** Senders/keywords this account must never delete, as JSON. */
  protections_json: string;
  last_connected_at: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FolderTable {
  id: string;
  account_id: string;
  remote_id: string;
  name: string;
  path: string;
  role: string;
  message_count: number | null;
  unread_count: number | null;
  is_protected: number;
  refreshed_at: string;
}

export interface RuleTable {
  id: string;
  user_id: string;
  account_id: string;
  name: string;
  query_json: string;
  mode: DeleteMode;
  enabled: number;
  /** Cron expression (5-field, UTC). Null = manual only. */
  schedule_cron: string | null;
  /** Auto-confirm scheduled runs. Manual runs always show a preview first. */
  auto_confirm: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobTable {
  id: string;
  user_id: string;
  account_id: string;
  rule_id: string | null;
  status: JobStatus;
  mode: DeleteMode;
  origin: string;
  query_json: string;
  /** Match counts, per-folder breakdown, byte totals. */
  stats_json: string;
  matched_count: number;
  deleted_count: number;
  failed_count: number;
  /** True when matches exceeded MAX_TRACKED_ITEMS, so ids were not all stored. */
  truncated: number;
  error: string | null;
  attempts: number;
  /** Worker lease — lets a crashed worker's job be reclaimed. */
  locked_by: string | null;
  locked_until: string | null;
  undo_expires_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  confirmed_at: string | null;
  finished_at: string | null;
}

export interface JobItemTable {
  id: Generated<number>;
  job_id: string;
  remote_id: string;
  folder_remote_id: string | null;
  /** Where the message was before deletion — needed to restore it. */
  origin_folder_id: string | null;
  subject: string | null;
  from_addr: string | null;
  sent_at: string | null;
  size_bytes: number | null;
  state: JobItemState;
  error: string | null;
  created_at: string;
}

export interface AuditLogTable {
  id: Generated<number>;
  user_id: string | null;
  account_id: string | null;
  job_id: string | null;
  action: string;
  detail_json: string;
  ip: string | null;
  created_at: string;
}

export interface OAuthStateTable {
  state: string;
  user_id: string;
  provider: ProviderId;
  code_verifier: string | null;
  /** Set when re-authorising an existing account rather than adding a new one. */
  account_id: string | null;
  redirect_to: string | null;
  created_at: string;
  expires_at: string;
}

export interface WaitlistTable {
  id: Generated<number>;
  name: string | null;
  email: string;
  company: string | null;
  phone: string | null;
  plan: string | null;
  mailboxes: string | null;
  message: string | null;
  source: string | null;
  ip: string | null;
  user_agent: string | null;
  notified: number;
  contacted: number;
  created_at: string;
}

export interface Database {
  users: UserTable;
  waitlist: WaitlistTable;
  mfa_challenges: MfaChallengeTable;
  login_attempts: LoginAttemptTable;
  accounts: AccountTable;
  folders: FolderTable;
  rules: RuleTable;
  jobs: JobTable;
  job_items: JobItemTable;
  audit_log: AuditLogTable;
  oauth_states: OAuthStateTable;
}
