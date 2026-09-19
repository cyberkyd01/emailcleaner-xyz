/**
 * Migrations are plain SQL, written to run unchanged on SQLite and Postgres:
 * TEXT for strings/timestamps/JSON, BIGINT for numbers, INTEGER 0/1 for booleans.
 * Auto-increment syntax differs between engines, so those columns are per-dialect.
 */
export interface Migration {
  name: string;
  up: (d: 'sqlite' | 'postgres') => string[];
}

const autoIncPk = (d: 'sqlite' | 'postgres') =>
  d === 'sqlite' ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'BIGSERIAL PRIMARY KEY';

export const migrations: Migration[] = [
  {
    name: '001_init',
    up: (d) => [
      `CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        is_admin      INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS accounts (
        id                TEXT PRIMARY KEY,
        user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider          TEXT NOT NULL,
        auth_type         TEXT NOT NULL,
        email             TEXT NOT NULL,
        display_name      TEXT,
        status            TEXT NOT NULL DEFAULT 'active',
        status_detail     TEXT,
        secret_enc        TEXT NOT NULL,
        scopes            TEXT,
        settings_json     TEXT NOT NULL DEFAULT '{}',
        protections_json  TEXT NOT NULL DEFAULT '{}',
        last_connected_at TEXT,
        last_error_at     TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS accounts_user_provider_email
         ON accounts (user_id, provider, email)`,

      `CREATE TABLE IF NOT EXISTS folders (
        id            TEXT PRIMARY KEY,
        account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        remote_id     TEXT NOT NULL,
        name          TEXT NOT NULL,
        path          TEXT NOT NULL,
        role          TEXT NOT NULL,
        message_count BIGINT,
        unread_count  BIGINT,
        is_protected  INTEGER NOT NULL DEFAULT 0,
        refreshed_at  TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS folders_account_remote
         ON folders (account_id, remote_id)`,

      `CREATE TABLE IF NOT EXISTS rules (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        query_json    TEXT NOT NULL,
        mode          TEXT NOT NULL DEFAULT 'trash',
        enabled       INTEGER NOT NULL DEFAULT 1,
        schedule_cron TEXT,
        auto_confirm  INTEGER NOT NULL DEFAULT 0,
        last_run_at   TEXT,
        next_run_at   TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS rules_due ON rules (enabled, next_run_at)`,

      `CREATE TABLE IF NOT EXISTS jobs (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        rule_id         TEXT,
        status          TEXT NOT NULL,
        mode            TEXT NOT NULL DEFAULT 'trash',
        origin          TEXT NOT NULL DEFAULT 'manual',
        query_json      TEXT NOT NULL,
        stats_json      TEXT NOT NULL DEFAULT '{}',
        matched_count   BIGINT NOT NULL DEFAULT 0,
        deleted_count   BIGINT NOT NULL DEFAULT 0,
        failed_count    BIGINT NOT NULL DEFAULT 0,
        truncated       INTEGER NOT NULL DEFAULT 0,
        error           TEXT,
        attempts        BIGINT NOT NULL DEFAULT 0,
        locked_by       TEXT,
        locked_until    TEXT,
        undo_expires_at TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        started_at      TEXT,
        confirmed_at    TEXT,
        finished_at     TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS jobs_claimable ON jobs (status, locked_until)`,
      `CREATE INDEX IF NOT EXISTS jobs_user_created ON jobs (user_id, created_at)`,

      `CREATE TABLE IF NOT EXISTS job_items (
        id               ${autoIncPk(d)},
        job_id           TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        remote_id        TEXT NOT NULL,
        folder_remote_id TEXT,
        origin_folder_id TEXT,
        subject          TEXT,
        from_addr        TEXT,
        sent_at          TEXT,
        size_bytes       BIGINT,
        state            TEXT NOT NULL DEFAULT 'matched',
        error            TEXT,
        created_at       TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS job_items_job ON job_items (job_id, state)`,

      `CREATE TABLE IF NOT EXISTS audit_log (
        id          ${autoIncPk(d)},
        user_id     TEXT,
        account_id  TEXT,
        job_id      TEXT,
        action      TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        ip          TEXT,
        created_at  TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS audit_user_created ON audit_log (user_id, created_at)`,

      `CREATE TABLE IF NOT EXISTS oauth_states (
        state         TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL,
        provider      TEXT NOT NULL,
        code_verifier TEXT,
        account_id    TEXT,
        redirect_to   TEXT,
        created_at    TEXT NOT NULL,
        expires_at    TEXT NOT NULL
      )`,
    ],
  },

  {
    name: '002_accounts_2fa_plans',
    up: (d) => [
      // Two-factor enrolment. The secret is stored encrypted, bound to the user id.
      `ALTER TABLE users ADD COLUMN totp_secret_enc TEXT`,
      `ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN totp_confirmed_at TEXT`,
      // JSON array of hashed single-use recovery codes.
      `ALTER TABLE users ADD COLUMN backup_codes_json TEXT`,

      `ALTER TABLE users ADD COLUMN display_name TEXT`,
      `ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'`,
      `ALTER TABLE users ADD COLUMN plan_started_at TEXT`,
      // 'active' or 'suspended'. Suspended users keep their data but cannot sign in.
      `ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
      `ALTER TABLE users ADD COLUMN last_login_at TEXT`,
      `ALTER TABLE users ADD COLUMN last_seen_at TEXT`,
      `ALTER TABLE users ADD COLUMN login_count BIGINT NOT NULL DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN accepted_terms_at TEXT`,

      // Short-lived handoff between the password step and the TOTP step, so a
      // valid password alone never yields a session.
      `CREATE TABLE IF NOT EXISTS mfa_challenges (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        attempts   BIGINT NOT NULL DEFAULT 0,
        ip         TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS mfa_challenges_expiry ON mfa_challenges (expires_at)`,

      // Drives lockout after repeated failures, keyed by email and by IP.
      `CREATE TABLE IF NOT EXISTS login_attempts (
        id         ${d === 'sqlite' ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'BIGSERIAL PRIMARY KEY'},
        identifier TEXT NOT NULL,
        ip         TEXT,
        success    INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS login_attempts_lookup ON login_attempts (identifier, created_at)`,
      `CREATE INDEX IF NOT EXISTS login_attempts_ip ON login_attempts (ip, created_at)`,
    ],
  },

  {
    name: '003_waitlist',
    up: (d) => [
      // Interest submissions are stored before the notification email is
      // attempted, so a mail outage can never lose a lead.
      `CREATE TABLE IF NOT EXISTS waitlist (
        id            ${d === 'sqlite' ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'BIGSERIAL PRIMARY KEY'},
        name          TEXT,
        email         TEXT NOT NULL,
        company       TEXT,
        phone         TEXT,
        plan          TEXT,
        mailboxes     TEXT,
        message       TEXT,
        source        TEXT,
        ip            TEXT,
        user_agent    TEXT,
        notified      INTEGER NOT NULL DEFAULT 0,
        contacted     INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS waitlist_created ON waitlist (created_at)`,
      `CREATE INDEX IF NOT EXISTS waitlist_email ON waitlist (email)`,
    ],
  },
];
