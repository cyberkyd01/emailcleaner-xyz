# Deploy Email Cleaner on a VPS (over SSH)

At the end of this guide Email Cleaner runs on your own Ubuntu/Debian server as two systemd services (the web app/API and the cleaning-job worker), behind nginx with a free Let's Encrypt certificate at `https://your-domain`. If you don't have a domain, you can run it at `http://SERVER-IP:8110` instead.

Every command is copy-paste. The guide is written for a server that **already hosts other things**: everything it creates is named `emailcleaner`, lives in its own folders, and leaves the rest of the box alone.

> Already running the production box described in [docs/deployment.md](docs/deployment.md) (openSUSE + Apache, port 8127)? That file is the runbook for that specific host. This guide is the generic, repeatable setup for Ubuntu/Debian.

## At a glance

| | |
| --- | --- |
| Install directory | `/opt/emailcleaner` (code in `releases/`, live version at `current`, data in `shared/`) |
| Settings | `/etc/emailcleaner/deploy.conf` (non-secret, the only file you edit) and `/opt/emailcleaner/shared/.env` (secrets, mode 600) |
| System user | `emailcleaner` (no login shell) |
| Services | `emailcleaner.service`: web pages + API on `127.0.0.1:3110`<br>`emailcleaner-worker.service`: runs cleaning jobs and scheduled rules (no port) |
| Public URL | `https://DOMAIN`, or `http://SERVER-IP:8110` if you have no domain |
| Runtime | Node.js 22, a private copy in `/opt/emailcleaner/runtime/node` |
| Database | SQLite file `/opt/emailcleaner/shared/data/email-cleaner.sqlite` (default). PostgreSQL is optional (step 8b). |
| Job queue | Kept in the database. No Redis needed. |
| Never touched | System Node/npm, other nginx sites, `nginx.conf`, the `default` site, existing PostgreSQL config, firewall policy, other apps' ports |

## Requirements

- **Server:** Ubuntu 22.04 or 24.04 LTS, or Debian 12, on x86_64 or arm64.
- **Size:** 1 vCPU, 1 GB RAM and 2 GB free disk is enough. The build peaks at about 450 MB RAM. If the server has less than 1 GB, add swap in step 3b. Each running process uses about 80–150 MB.
- **Access:** SSH as root or as a user with `sudo`. Minimal Debian logged in as root: run `apt-get install -y sudo` first.
- **Domain (recommended):** a DNS **A record** pointing at the server's IPv4 address, e.g. `clean.example.com → 203.0.113.10`. If you use Cloudflare, set the record to **DNS only** (grey cloud) while you get the certificate.
- **Outbound network:** port **993** (IMAP) and **443** (Gmail/Microsoft APIs, Let's Encrypt). Some providers block 993 outbound by default. The preflight step tests it.
- **Optional accounts:** a Google Cloud OAuth client (for "Connect Gmail") and/or a Microsoft Entra app (for "Connect Outlook"). Both need the domain + HTTPS (step 13). IMAP mailboxes (Yahoo, iCloud, GMX, Mail.com, Zoho, Fastmail, any IMAP host) work with no accounts at all.
- **HSTS note:** over HTTPS the app sends `Strict-Transport-Security` with `includeSubDomains`. If you use an apex domain such as `example.com`, all of its subdomains must also serve HTTPS. A dedicated subdomain like `clean.example.com` avoids that.

---

## 1. Connect and set your variables

```bash
ssh root@YOUR_SERVER_IP        # or: ssh youruser@YOUR_SERVER_IP
```

Before you paste the block below, edit `DOMAIN` and `EMAIL` in it. Leave `DOMAIN` empty to run on the server IP. This file is the only place you set values; every later block reads it, so if your SSH session drops you can carry on where you stopped.

```bash
sudo mkdir -p /etc/emailcleaner
sudo tee /etc/emailcleaner/deploy.conf >/dev/null <<'CONF'
# Email Cleaner deployment settings. Every step of DEPLOY.md reads this file.
APP=emailcleaner
APP_USER=emailcleaner
APP_HOME=/opt/emailcleaner
REPO_URL=git@github.com:cyberkyd01/emailcleaner-xyz.git
BRANCH=main
PORT=3110          # the app listens on 127.0.0.1:PORT only (never public)
PUBLIC_PORT=8110   # used only when DOMAIN is empty: http://SERVER-IP:PUBLIC_PORT
DOMAIN=            # e.g. clean.example.com (leave empty to run on the server IP)
EMAIL=             # your email, for Let's Encrypt expiry notices (needed when DOMAIN is set)
NODE_MAJOR=22
CONF
sudo chmod 644 /etc/emailcleaner/deploy.conf
cat /etc/emailcleaner/deploy.conf
```

To change something later, run `sudo nano /etc/emailcleaner/deploy.conf`. Pasting the block above again resets the file to these values. See [Changing settings later](#changing-settings-later) for which steps to re-run after an edit.

## 2. Preflight checks

This only reads things; it changes nothing. Every line should start with `OK`. A `STOP` line tells you what to fix before you continue. A `WARN` line is information.

```bash
sudo bash <<'EOF'
source /etc/emailcleaner/deploy.conf
. /etc/os-release
echo "System: $PRETTY_NAME, $(uname -m)"
case "$ID:$VERSION_ID" in
  ubuntu:22.04|ubuntu:24.04|debian:12) echo "OK    supported OS" ;;
  *) echo "WARN  untested OS: this guide targets Ubuntu 22.04/24.04 and Debian 12" ;;
esac
case "$(uname -m)" in x86_64|aarch64) echo "OK    CPU architecture" ;; *) echo "STOP  unsupported CPU $(uname -m)" ;; esac
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
if [ $((MEM_MB + SWAP_MB)) -ge 900 ]; then echo "OK    RAM ${MEM_MB} MB + swap ${SWAP_MB} MB"; else echo "WARN  only ${MEM_MB} MB RAM + ${SWAP_MB} MB swap: do step 3b (swap)"; fi
DISK_MB=$(df -Pm / | awk 'NR==2 {print $4}')
if [ "$DISK_MB" -ge 2048 ]; then echo "OK    ${DISK_MB} MB free disk"; else echo "STOP  only ${DISK_MB} MB free disk (need 2 GB)"; fi
owner() { ss -ltnpH "sport = :$1" | grep -oE 'users:\(\("[^"]+"' | cut -d'"' -f2 | sort -u | tr '\n' ' '; }
if [ -z "$(ss -ltnH "sport = :$PORT")" ]; then echo "OK    port $PORT is free"
elif systemctl is-active --quiet emailcleaner; then echo "OK    port $PORT is used by emailcleaner itself (re-run)"
else echo "STOP  port $PORT is used by: $(owner "$PORT"). Set PORT to a free port in /etc/emailcleaner/deploy.conf"; fi
if [ -z "$DOMAIN" ]; then
  if [ -z "$(ss -ltnH "sport = :$PUBLIC_PORT")" ]; then echo "OK    public port $PUBLIC_PORT is free (no-domain mode)"
  elif grep -qs "listen $PUBLIC_PORT" /etc/nginx/sites-available/emailcleaner /etc/nginx/conf.d/emailcleaner.conf; then echo "OK    public port $PUBLIC_PORT is already this app's nginx site (re-run)"
  else echo "STOP  public port $PUBLIC_PORT is used by: $(owner "$PUBLIC_PORT"). Set PUBLIC_PORT to a free port in deploy.conf"; fi
fi
WEB=$(ss -ltnpH '( sport = :80 or sport = :443 )' | grep -oE 'users:\(\("[^"]+"' | cut -d'"' -f2 | sort -u | tr '\n' ' ')
case "$WEB" in
  "") echo "OK    ports 80/443 are free: nginx will be installed in step 11" ;;
  "nginx ") echo "OK    nginx serves 80/443: a separate emailcleaner site will be added" ;;
  *) echo "STOP  ports 80/443 belong to: $WEB. Do not install nginx; in step 11 use the Appendix (Caddy/Apache)" ;;
esac
if timeout 6 bash -c '</dev/tcp/imap.gmail.com/993' 2>/dev/null; then echo "OK    outbound IMAP (993) works"; else echo "WARN  outbound port 993 looks blocked: IMAP mailboxes will time out (ask your provider to open it)"; fi
if [ -n "$DOMAIN" ]; then
  [ -n "$EMAIL" ] && echo "OK    EMAIL is set" || echo "STOP  EMAIL is empty in deploy.conf (Let's Encrypt needs it)"
  SERVER_IP=$(curl -4fsS --max-time 10 https://api.ipify.org || echo unknown)
  DNS_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}')
  if [ -n "$DNS_IP" ] && [ "$DNS_IP" = "$SERVER_IP" ]; then echo "OK    $DOMAIN points at this server ($SERVER_IP)"
  else echo "WARN  $DOMAIN resolves to '${DNS_IP:-nothing}', this server is $SERVER_IP. Fix the A record before step 11b (it can propagate meanwhile)"; fi
else
  echo "OK    no DOMAIN set: no-domain mode (http://SERVER-IP:$PUBLIC_PORT, Gmail/Outlook OAuth unavailable)"
fi
EOF
```

## 3. Install system packages

This only adds packages; nothing is upgraded or removed. `python3`, `make` and `g++` are there in case the SQLite driver (`better-sqlite3`) has no prebuilt binary for your CPU and has to compile one. `sqlite3` is the command-line tool used for backups.

```bash
sudo bash -euo pipefail <<'EOF'
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1   # additive only: needrestart must not restart other services
source /etc/emailcleaner/deploy.conf
export DEBIAN_FRONTEND=noninteractive
apt-get update
MISSING_PKGS=""; for p in ca-certificates curl git openssh-client xz-utils openssl sqlite3 python3 make g++; do dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'ok installed' || MISSING_PKGS="$MISSING_PKGS $p"; done
if [ -n "$MISSING_PKGS" ]; then apt-get install -y --no-install-recommends $MISSING_PKGS </dev/null; fi   # only what's missing - never upgrades installed packages
echo "OK: packages installed"
EOF
```

### 3b. Optional: add swap (servers with less than 1 GB RAM)

This step does nothing if the server already has swap.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/emailcleaner/deploy.conf
if [ -n "$(swapon --show --noheadings)" ]; then echo "Swap already active, nothing to do"; exit 0; fi
fallocate -l 2G /swapfile-emailcleaner 2>/dev/null || dd if=/dev/zero of=/swapfile-emailcleaner bs=1M count=2048 status=none
chmod 600 /swapfile-emailcleaner
mkswap /swapfile-emailcleaner >/dev/null
swapon /swapfile-emailcleaner
grep -q '^/swapfile-emailcleaner ' /etc/fstab || echo '/swapfile-emailcleaner none swap sw 0 0' >> /etc/fstab
swapon --show
EOF
```

## 4. Create the app user and folders

The app user owns only what it needs to write to. The top folder, the `bin/` folder (which holds the deploy script that runs as root) and the Node runtime stay owned by root, so the app user cannot change anything that root executes.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/emailcleaner/deploy.conf
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --user-group --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
install -d -o root -g "$APP_USER" -m 750 "$APP_HOME"
install -d -o root -g root -m 755 "$APP_HOME/bin" "$APP_HOME/runtime"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_HOME/releases" "$APP_HOME/shared" "$APP_HOME/repo" "$APP_HOME/.npm" "$APP_HOME/.cache"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$APP_HOME/.ssh" "$APP_HOME/shared/data" "$APP_HOME/backups"
install -d -o root -g root -m 755 /etc/emailcleaner
ls -la "$APP_HOME"
EOF
```

You should see `bin`, `releases`, `repo`, `runtime`, `shared` and `backups` listed.

## 5. Install the runtime (isolated)

This downloads the official Node.js 22 build into `/opt/emailcleaner/runtime/node` and checks its SHA-256. It doesn't touch any system Node, nvm or other Node install. If Node 22 is already there, the block skips the download.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/emailcleaner/deploy.conf
if "$APP_HOME/runtime/node/bin/node" -v 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
  echo "Node $("$APP_HOME/runtime/node/bin/node" -v) already installed"; exit 0
fi
case "$(uname -m)" in x86_64) NARCH=x64 ;; aarch64|arm64) NARCH=arm64 ;; *) echo "Unsupported CPU: $(uname -m)"; exit 1 ;; esac
BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
TARBALL="$(curl -fsSL "$BASE/SHASUMS256.txt" | grep -oE "node-v[0-9.]+-linux-${NARCH}\.tar\.xz" | head -1)"
TMP="$(mktemp -d)"
curl -fsSL "$BASE/$TARBALL" -o "$TMP/$TARBALL"
(cd "$TMP" && curl -fsSL "$BASE/SHASUMS256.txt" | grep " $TARBALL\$" | sha256sum -c -)
rm -rf "$APP_HOME/runtime/node" && mkdir -p "$APP_HOME/runtime/node"
tar -xJf "$TMP/$TARBALL" -C "$APP_HOME/runtime/node" --strip-components=1
rm -rf "$TMP"
chown -R root:root "$APP_HOME/runtime"
"$APP_HOME/runtime/node/bin/node" -v
"$APP_HOME/runtime/node/bin/npm" -v
EOF
```

You should see `v22.x.x` and an npm version.

## 6. Give the server read access to the repo

The repository is private, so the server needs a **read-only deploy key**.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/emailcleaner/deploy.conf
KEY="$APP_HOME/.ssh/id_ed25519"
[ -f "$KEY" ] || sudo -u "$APP_USER" ssh-keygen -q -t ed25519 -N '' -C "$APP@$(hostname)" -f "$KEY" </dev/null
sudo -u "$APP_USER" touch "$APP_HOME/.ssh/known_hosts"
if ! grep -q '^github.com ssh-ed25519' "$APP_HOME/.ssh/known_hosts"; then
  ssh-keyscan -t ed25519 github.com 2>/dev/null | sudo -u "$APP_USER" tee -a "$APP_HOME/.ssh/known_hosts" >/dev/null
fi
echo
echo "Copy the line below and paste it at https://github.com/cyberkyd01/emailcleaner-xyz/settings/keys/new"
echo "Title: $APP@$(hostname). Leave 'Allow write access' UNTICKED."
echo
cat "$KEY.pub"
EOF
```

When the key is saved on GitHub, test it:

```bash
sudo bash <<'EOF'
source /etc/emailcleaner/deploy.conf
OUT=$(sudo -u "$APP_USER" -H ssh -T -o BatchMode=yes git@github.com </dev/null 2>&1)
case "$OUT" in
  *"successfully authenticated"*) echo "OK    GitHub accepts the deploy key" ;;
  *) echo "STOP  GitHub refused the key: $OUT" ;;
esac
EOF
```

You should see `OK    GitHub accepts the deploy key`. If the repository is public, skip this step and put `REPO_URL=https://github.com/cyberkyd01/emailcleaner-xyz.git` in `deploy.conf` instead.

## 7. Configure the app (.env)

The app reads `.env` from its working directory itself (`src/config.ts`), so the file lives at `/opt/emailcleaner/shared/.env` and every release gets a symlink to it. The block below creates the file **only if it doesn't exist yet**, so running it again never replaces your secrets.

> **`ENCRYPTION_KEY` is generated once and must never change.** It encrypts every stored Gmail/Outlook refresh token and IMAP app password (AES-256-GCM). If you lose it or regenerate it, every connected mailbox must be connected again. Back it up (see [Backups](#backups-and-restore)).

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/emailcleaner/deploy.conf
ENV="$APP_HOME/shared/.env"
if [ -s "$ENV" ]; then
  echo ".env already exists: keeping it (secrets are never regenerated)"
else
  umask 077
  cat > "$ENV" <<ENVFILE
# Email Cleaner settings. Owner emailcleaner, mode 600. Restart both services after editing:
#   sudo systemctl restart emailcleaner emailcleaner-worker
# NODE_ENV, HOST, PORT, PUBLIC_BASE_URL and RUN_WORKER_IN_PROCESS are set by the systemd units
# (step 9, from /etc/emailcleaner/deploy.conf). Values for them in this file are ignored.
# To use a default, delete or comment out the line; an empty value is not always the same as unset.

# --- Secrets: generated once. NEVER change ENCRYPTION_KEY (stored mailbox credentials become unreadable).
ENCRYPTION_KEY=$(openssl rand -base64 32)
SESSION_SECRET=$(openssl rand -base64 48)

# --- Database (absolute path, outside the release folders)
DATABASE_URL=sqlite:$APP_HOME/shared/data/email-cleaner.sqlite

# --- Gmail / Google Workspace (optional, step 13). Redirect URI: https://DOMAIN/api/oauth/gmail/callback
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_SCOPE_LEVEL=modify

# --- Outlook / Microsoft 365 (optional, step 13). Redirect URI: https://DOMAIN/api/oauth/microsoft/callback
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT=common

# --- Safety rails and worker
MAX_DELETE_PER_JOB=25000
MAX_TRACKED_ITEMS=50000
UNDO_WINDOW_DAYS=30
WORKER_CONCURRENCY=2
IMAP_ALLOW_INSECURE_TLS=false

# --- Accounts and sign-in
ALLOW_REGISTRATION=true
ENFORCE_2FA=false
MAX_LOGIN_ATTEMPTS=8
LOGIN_LOCKOUT_MINUTES=15
CAPTCHA_PROVIDER=none
# CAPTCHA_SITE_KEY=
# CAPTCHA_SECRET_KEY=
CAPTCHA_MIN_SCORE=0.5

# --- Brand and legal identity (shown on the public and legal pages, and to Google/Microsoft reviewers)
BRAND_NAME=Email Cleaner
SUPPORT_EMAIL=support@emailcleaner.xyz
PRIVACY_EMAIL=privacy@emailcleaner.xyz
LEGAL_JURISDICTION=India
# LEGAL_ENTITY=Your Company Ltd
# POSTAL_ADDRESS=1 Example Street, City

# --- SEO: false = noindex everywhere (use on staging)
SEO_INDEXABLE=true

# --- Outbound notification mail (waitlist form only). Needs an MTA that accepts unauthenticated,
# plain SMTP at SMTP_HOST:SMTP_PORT (e.g. a local Postfix). Leave false if you don't run one.
MAIL_ENABLED=false
SMTP_HOST=127.0.0.1
SMTP_PORT=25
MAIL_FROM=support@emailcleaner.xyz
MAIL_HELO=emailcleaner.xyz
NOTIFY_EMAIL=support@emailcleaner.xyz

LOG_LEVEL=info
ENVFILE
  echo "Created $ENV"
fi
chown "$APP_USER:$APP_USER" "$ENV"
chmod 600 "$ENV"
if grep -q '^ENCRYPTION_KEY=..' "$ENV"; then echo "OK: ENCRYPTION_KEY present"; else echo "STOP: ENCRYPTION_KEY missing in $ENV"; fi
EOF
```

Every variable the code reads (`src/config.ts`):

| Variable | Required | Set to / meaning |
| --- | --- | --- |
| `ENCRYPTION_KEY` | **yes** | 32 random bytes, base64. Encrypts stored mailbox credentials. Generated above. **Never change it.** |
| `SESSION_SECRET` | **yes** | Random bytes, base64. Signs sign-in sessions. Changing it signs everyone out, nothing worse. |
| `DATABASE_URL` | yes | `sqlite:/opt/emailcleaner/shared/data/email-cleaner.sqlite`, or `postgres://…` (step 8b). |
| `NODE_ENV`, `HOST`, `PORT`, `PUBLIC_BASE_URL`, `RUN_WORKER_IN_PROCESS` | set by systemd | `production` (domain) or `development` (no-domain, see step 9), `127.0.0.1`, `3110`, `https://DOMAIN` or `http://IP:8110`, `false`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | for Gmail | From Google Cloud (step 13). Empty means Gmail shows "not configured". |
| `GOOGLE_SCOPE_LEVEL` | no | `modify` (move to Trash, recommended) or `full` (permanent delete, needs Google's CASA Tier 3 assessment). |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | for Outlook | From Microsoft Entra (step 13). |
| `MICROSOFT_TENANT` | no | `common` (personal + work), `consumers`, `organizations`, or a tenant GUID. Don't leave it empty. |
| `MAX_DELETE_PER_JOB` | no | Jobs above this need an explicit acknowledgement (default 25000). |
| `MAX_TRACKED_ITEMS` | no | Per-message rows kept for preview and undo (default 50000). |
| `UNDO_WINDOW_DAYS` | no | How long a move-to-Trash job can be undone (default 30). |
| `WORKER_CONCURRENCY` | no | Jobs the worker runs at once (default 2). Use `1` on a busy, small server. |
| `WORKER_POLL_INTERVAL_MS` | no | How often an idle worker checks for jobs (default 2000). |
| `IMAP_ALLOW_INSECURE_TLS` | no | Must stay `false` in production (the app refuses to start otherwise). |
| `ALLOW_REGISTRATION` | no | `true` until you've created your accounts, then `false` (step 12). |
| `ENFORCE_2FA` | no | `true` makes every account enrol in TOTP. |
| `MAX_LOGIN_ATTEMPTS`, `LOGIN_LOCKOUT_MINUTES` | no | Lockout policy (8 attempts, 15 minutes). |
| `CAPTCHA_PROVIDER`, `CAPTCHA_SITE_KEY`, `CAPTCHA_SECRET_KEY`, `CAPTCHA_MIN_SCORE` | no | `none`, `recaptcha` (v3) or `turnstile`; both keys are needed when a provider is set. Don't leave `CAPTCHA_MIN_SCORE` empty. |
| `BRAND_NAME`, `LEGAL_ENTITY`, `SUPPORT_EMAIL`, `PRIVACY_EMAIL`, `POSTAL_ADDRESS`, `LEGAL_JURISDICTION` | no | Shown on the public and legal pages. Comment a line out rather than leaving it empty, or the page shows a blank. |
| `SEO_INDEXABLE` | no | `false` on staging. |
| `MAIL_ENABLED`, `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM`, `MAIL_HELO`, `NOTIFY_EMAIL` | no | Waitlist notification emails, sent over plain unauthenticated SMTP. `false` unless a local MTA accepts mail. |
| `LOG_LEVEL` | no | `debug`, `info`, `warn` or `error`. |
| `YAHOO_CLIENT_ID` / `YAHOO_CLIENT_SECRET` | no | Read but not used by the current code; Yahoo works over IMAP with an app password. |

## 8. Database

**Default: SQLite, nothing to do.** The database file is created at `/opt/emailcleaner/shared/data/email-cleaner.sqlite` on the first deploy. Migrations run automatically on every deploy (and again, as a no-op, whenever a service starts). The web process and the worker share the file safely: the app turns on SQLite WAL mode and uses database leases for jobs.

### 8b. Optional: use PostgreSQL instead

Skip this unless you want PostgreSQL. It creates a dedicated `emailcleaner` role and database inside your existing PostgreSQL server, or installs PostgreSQL if there isn't one. It never edits PostgreSQL's config. It doesn't migrate data either, so do it **before** the first deploy, or you start with an empty database.

```bash
sudo bash -euo pipefail <<'EOF'
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1   # additive only: needrestart must not restart other services
source /etc/emailcleaner/deploy.conf
ENV="$APP_HOME/shared/.env"
if grep -q '^DATABASE_URL=postgres' "$ENV"; then echo "Already using PostgreSQL, nothing to do"; exit 0; fi
export DEBIAN_FRONTEND=noninteractive
command -v pg_lsclusters >/dev/null || { apt-get update; apt-get install -y --no-install-recommends postgresql </dev/null; }
PGPORT=$(pg_lsclusters --no-header | awk '$4=="online" && !p {print $3; p=1}')
[ -n "$PGPORT" ] || { echo "STOP: no running PostgreSQL cluster (check: pg_lsclusters)"; exit 1; }
PGPASS=$(openssl rand -hex 24)
cd /
if [ "$(sudo -u postgres psql -p "$PGPORT" -tAc "SELECT 1 FROM pg_roles WHERE rolname='emailcleaner'")" = 1 ]; then
  sudo -u postgres psql -p "$PGPORT" -qc "ALTER ROLE emailcleaner WITH LOGIN PASSWORD '$PGPASS'"
else
  sudo -u postgres psql -p "$PGPORT" -qc "CREATE ROLE emailcleaner WITH LOGIN PASSWORD '$PGPASS'"
fi
if [ "$(sudo -u postgres psql -p "$PGPORT" -tAc "SELECT 1 FROM pg_database WHERE datname='emailcleaner'")" != 1 ]; then
  sudo -u postgres createdb -p "$PGPORT" -O emailcleaner emailcleaner
fi
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgres://emailcleaner:$PGPASS@127.0.0.1:$PGPORT/emailcleaner|" "$ENV"
chown "$APP_USER:$APP_USER" "$ENV"; chmod 600 "$ENV"
echo "OK: DATABASE_URL now points at PostgreSQL on 127.0.0.1:$PGPORT"
EOF
```

## 9. Run it as a service (systemd)

The block writes two units. They're enabled now and started by the first deploy in step 10.

- `emailcleaner.service` runs the web pages and API (`dist/src/index.js`) on `127.0.0.1:PORT`, with `RUN_WORKER_IN_PROCESS=false`.
- `emailcleaner-worker.service` runs the cleaning jobs and scheduled rules (`dist/src/worker.js`). Long deletions run here, so a restart of the web process doesn't interrupt them. When the worker stops, in-flight jobs get 90 seconds to wind down. A job cut off mid-way is picked up again after its 5-minute lease runs out.

**No-domain mode:** the app refuses to start with `NODE_ENV=production` unless `PUBLIC_BASE_URL` is `https://` (`assertRuntimeConfig` in `src/config.ts`). Without a domain the block therefore sets `NODE_ENV=development`. The only other effects are human-readable log lines and stack traces in the journal. Treat no-domain mode as a trial setup.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/emailcleaner/deploy.conf
if [ -n "$DOMAIN" ]; then
  PUBLIC_URL="https://$DOMAIN"; RUN_ENV=production
else
  IP="$(curl -4fsS --max-time 10 https://api.ipify.org)"
  PUBLIC_URL="http://$IP:$PUBLIC_PORT"; RUN_ENV=development
fi
COMMON="User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_HOME/current
Environment=PATH=$APP_HOME/runtime/node/bin:/usr/bin:/bin
Environment=NODE_ENV=$RUN_ENV
Environment=PUBLIC_BASE_URL=$PUBLIC_URL
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$APP_HOME"
cat > /etc/systemd/system/emailcleaner.service <<UNIT
[Unit]
Description=Email Cleaner web + API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
$COMMON
Environment=HOST=127.0.0.1
Environment=PORT=$PORT
Environment=RUN_WORKER_IN_PROCESS=false
ExecStart=$APP_HOME/runtime/node/bin/node dist/src/index.js
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/emailcleaner-worker.service <<UNIT
[Unit]
Description=Email Cleaner job worker
After=network-online.target emailcleaner.service
Wants=network-online.target

[Service]
Type=simple
$COMMON
ExecStart=$APP_HOME/runtime/node/bin/node dist/src/worker.js
TimeoutStopSec=90

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable emailcleaner.service emailcleaner-worker.service
if [ -e "$APP_HOME/current" ]; then systemctl restart emailcleaner emailcleaner-worker; fi
echo "OK: units installed (NODE_ENV=$RUN_ENV, PUBLIC_BASE_URL=$PUBLIC_URL)"
EOF
```

You should see `OK: units installed …` with your URL.

## 10. Create the deploy script and deploy

`/opt/emailcleaner/bin/deploy.sh` handles the first install and every update. Each run:

1. fetches the branch and unpacks it into a new folder under `releases/`;
2. links `shared/.env` and `shared/data` into it;
3. runs `npm ci`, `npm run build` (TypeScript to `dist/`, plus the static UI), `npm prune --omit=dev`, then the database migrations;
4. switches the `current` symlink, restarts both services and checks `/api/health`;
5. switches back to the previous release by itself if the health check fails.

The last 3 releases are kept.

```bash
sudo tee /opt/emailcleaner/bin/deploy.sh >/dev/null <<'DEPLOY'
#!/usr/bin/env bash
# Deploys the latest commit of $BRANCH. First install and every update. Safe to re-run.
set -Eeuo pipefail
source /etc/emailcleaner/deploy.conf
[ "$(id -u)" -eq 0 ] || { echo "Run with: sudo $0"; exit 1; }

RELEASES="$APP_HOME/releases"; SHARED="$APP_HOME/shared"; REPO="$APP_HOME/repo"
# Root only runs system binaries; the private Node runtime is used as the app user.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
APP_PATH="$APP_HOME/runtime/node/bin:/usr/local/bin:/usr/bin:/bin"
as_app() { sudo -u "$APP_USER" -H env HOME="$APP_HOME" PATH="$APP_PATH" bash -euo pipefail -c "$1"; }

SHARED_FILES=(.env)
SHARED_DIRS=(data)
SERVICES=(emailcleaner emailcleaner-worker)
HEALTH_URL="http://127.0.0.1:$PORT/api/health"

[ -x "$APP_HOME/runtime/node/bin/node" ] || { echo "Node runtime missing: run step 5 of DEPLOY.md"; exit 1; }
[ -s "$SHARED/.env" ] || { echo "$SHARED/.env missing: run step 7 of DEPLOY.md"; exit 1; }

echo "==> Fetching $BRANCH"
if [ ! -d "$REPO/.git" ]; then as_app "git clone --quiet '$REPO_URL' '$REPO'"; fi
as_app "cd '$REPO' && git remote set-url origin '$REPO_URL' && git fetch --quiet --prune origin '$BRANCH' && git reset --quiet --hard 'origin/$BRANCH'"
SHA="$(as_app "cd '$REPO' && git rev-parse --short HEAD")"
NEW="$RELEASES/$(date +%Y%m%d%H%M%S)-$SHA"
trap 'echo "!! Deploy failed before the switch; the running version is untouched" >&2; rm -rf "$NEW"' ERR
as_app "mkdir -p '$NEW' && cd '$REPO' && git archive HEAD | tar -x -C '$NEW'"

echo "==> Linking shared files"
for f in "${SHARED_FILES[@]}"; do as_app "touch '$SHARED/$f' && ln -sfn '$SHARED/$f' '$NEW/$f'"; done
for d in "${SHARED_DIRS[@]}"; do as_app "mkdir -p '$SHARED/$d' && rm -rf '$NEW/$d' && mkdir -p \"\$(dirname '$NEW/$d')\" && ln -sfn '$SHARED/$d' '$NEW/$d'"; done

echo "==> Installing dependencies and building"
as_app "cd '$NEW' && npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev --no-audit --no-fund"

echo "==> Running database migrations"
as_app "cd '$NEW' && node dist/src/db/migrate.js"
trap - ERR

echo "==> Switching to $NEW"
PREV="$(readlink -f "$APP_HOME/current" 2>/dev/null || true)"
ln -sfn "$NEW" "$APP_HOME/current.new" && mv -Tf "$APP_HOME/current.new" "$APP_HOME/current"
systemctl restart "${SERVICES[@]}"

echo "==> Health check $HEALTH_URL"
for i in $(seq 1 45); do
  if curl -fsS -o /dev/null --max-time 5 "$HEALTH_URL"; then
    echo "==> Deployed $SHA"
    ls -1dt "$RELEASES"/*/ | tail -n +4 | xargs -r rm -rf   # keep last 3
    exit 0
  fi
  sleep 2
done
echo "!! Health check failed: rolling back" >&2
journalctl -u "${SERVICES[0]}" -n 40 --no-pager >&2 || true
if [ -n "$PREV" ] && [ -d "$PREV" ]; then
  ln -sfn "$PREV" "$APP_HOME/current.new" && mv -Tf "$APP_HOME/current.new" "$APP_HOME/current"
  systemctl restart "${SERVICES[@]}"
  echo "!! Rolled back to $PREV" >&2
fi
exit 1
DEPLOY
sudo chown root:root /opt/emailcleaner/bin/deploy.sh
sudo chmod 750 /opt/emailcleaner/bin/deploy.sh
```

Run the first deploy (1–3 minutes):

```bash
sudo /opt/emailcleaner/bin/deploy.sh
```

It should end with `==> Deployed <commit>`. Check both services:

```bash
systemctl is-active emailcleaner emailcleaner-worker
```

You should see `active` twice.

## 11. Put it on your domain (nginx + HTTPS)

If the preflight said ports 80/443 belong to Apache, Caddy or anything other than nginx, **skip this step** and use the [Appendix](#appendix-caddy--apache-instead-of-nginx).

The block adds one nginx site, `emailcleaner`, and nothing else. It installs nginx only if nginx is missing, tests the config before reloading, and removes its own site again if the test fails.

- **Domain mode:** listens on port 80 for `server_name DOMAIN`. Step 11b adds HTTPS.
- **No-domain mode:** listens on `PUBLIC_PORT` (8110). The app's Content-Security-Policy includes `upgrade-insecure-requests`, which makes browsers try to load every stylesheet, script and link over `https://SERVER-IP:8110`. That fails on a plain-HTTP port and leaves the pages unstyled and the links broken. In this mode only, nginx replaces that one header with the same policy minus `upgrade-insecure-requests`. Leave `CAPTCHA_PROVIDER=none` in no-domain mode, because the replaced policy doesn't allow captcha scripts.

Progress updates reach the browser through server-sent events. The app sends `X-Accel-Buffering: no`, so nginx doesn't buffer them, and the 300-second timeouts stop long streams from being cut off.

```bash
sudo bash -euo pipefail <<'EOF'
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1   # additive only: needrestart must not restart other services
source /etc/emailcleaner/deploy.conf
WEB=$(ss -ltnpH '( sport = :80 or sport = :443 )' | grep -oE 'users:\(\("[^"]+"' | cut -d'"' -f2 | sort -u | tr '\n' ' ')
case "$WEB" in ""|"nginx ") ;; *) echo "STOP: ports 80/443 belong to: $WEB. Use the Appendix instead of nginx."; exit 1 ;; esac
export DEBIAN_FRONTEND=noninteractive
command -v nginx >/dev/null || { apt-get update; apt-get install -y --no-install-recommends nginx </dev/null; }
if [ -d /etc/nginx/sites-available ]; then SITE=/etc/nginx/sites-available/emailcleaner; else SITE=/etc/nginx/conf.d/emailcleaner.conf; fi
if [ -n "$DOMAIN" ]; then LPORT=80; else LPORT=$PUBLIC_PORT; fi
LISTEN="    listen $LPORT;"
[ -e /proc/net/if_inet6 ] && LISTEN="$LISTEN
    listen [::]:$LPORT;"
if [ -n "$DOMAIN" ]; then NAME="    server_name $DOMAIN;"; CSP=""; else
  NAME="    # no-domain mode: reached at http://SERVER-IP:$PUBLIC_PORT"
  CSP="        # No HTTPS in no-domain mode: same policy as the app sends, minus upgrade-insecure-requests
        proxy_hide_header Content-Security-Policy;
        add_header Content-Security-Policy \"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'\" always;"
fi
cat > "$SITE" <<NGINX
# Email Cleaner: reverse proxy to 127.0.0.1:$PORT (written by DEPLOY.md, step 11)
server {
$LISTEN
$NAME
    access_log /var/log/nginx/emailcleaner.access.log;
    error_log  /var/log/nginx/emailcleaner.error.log;
    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
$CSP
    }
}
NGINX
[ "$SITE" = /etc/nginx/sites-available/emailcleaner ] && ln -sfn "$SITE" /etc/nginx/sites-enabled/emailcleaner
if ! nginx -t; then
  rm -f "$SITE" /etc/nginx/sites-enabled/emailcleaner
  echo "STOP: nginx config test failed. The emailcleaner site was removed and nothing was reloaded."; exit 1
fi
if systemctl is-active --quiet nginx; then systemctl reload nginx; else systemctl enable --now nginx; fi
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  if [ -n "$DOMAIN" ]; then ufw allow 80/tcp; ufw allow 443/tcp; else ufw allow "$PUBLIC_PORT/tcp"; fi
fi
echo "OK: nginx site $SITE is live"
EOF
```

If your cloud provider has its own firewall (security groups, e.g. on AWS, Oracle, Hetzner Cloud or GCP), open TCP 80 and 443 there too, or TCP 8110 in no-domain mode.

### 11b. HTTPS certificate (domain mode only)

```bash
sudo bash -euo pipefail <<'EOF'
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1   # additive only: needrestart must not restart other services
source /etc/emailcleaner/deploy.conf
[ -n "$DOMAIN" ] || { echo "No DOMAIN set: no-domain mode, skip this step."; exit 0; }
[ -n "$EMAIL" ] || { echo "STOP: set EMAIL in /etc/emailcleaner/deploy.conf"; exit 1; }
SERVER_IP=$(curl -4fsS --max-time 10 https://api.ipify.org)
DNS_IPS=$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u | tr '\n' ' ')
case " $DNS_IPS" in
  *" $SERVER_IP "*) echo "OK: $DOMAIN points at $SERVER_IP" ;;
  *) echo "STOP: $DOMAIN resolves to '${DNS_IPS:-nothing}', not this server ($SERVER_IP). Fix the DNS A record (Cloudflare: DNS only) and retry."; exit 1 ;;
esac
export DEBIAN_FRONTEND=noninteractive
if ! command -v certbot >/dev/null || ! dpkg -s python3-certbot-nginx >/dev/null 2>&1; then
  apt-get update; apt-get install -y --no-install-recommends certbot python3-certbot-nginx </dev/null
fi
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect --keep-until-expiring
nginx -t && systemctl reload nginx
echo "OK: https://$DOMAIN is live"
EOF
```

Certbot edits only the `emailcleaner` server block, and the certbot package's timer renews the certificate automatically.

## 12. Verify

```bash
source /etc/emailcleaner/deploy.conf
systemctl is-active emailcleaner emailcleaner-worker
curl -fsS "http://127.0.0.1:$PORT/api/health"; echo
if [ -n "$DOMAIN" ]; then curl -sSI "https://$DOMAIN/" | head -1; else curl -sSI "http://127.0.0.1:$PUBLIC_PORT/" | head -1; fi
```

Expected output:

- `active` twice;
- `{"ok":true,"version":2,"database":"sqlite","workerInProcess":false,…}`;
- `HTTP/2 200` or `HTTP/1.1 200 OK`.

**Create the admin account.** Open `https://DOMAIN/login`, or `http://SERVER-IP:8110/login` in no-domain mode, and register. **The first account registered becomes the administrator**, and `/admin` is the operations dashboard. Turn on two-factor authentication in the app's account settings.

**Then close registration.** As soon as the certificate exists, the hostname is public in Certificate Transparency logs, and scanners find new sites within minutes.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/emailcleaner/deploy.conf
sed -i 's/^ALLOW_REGISTRATION=.*/ALLOW_REGISTRATION=false/' "$APP_HOME/shared/.env"
chown "$APP_USER:$APP_USER" "$APP_HOME/shared/.env"; chmod 600 "$APP_HOME/shared/.env"
systemctl restart emailcleaner emailcleaner-worker
grep '^ALLOW_REGISTRATION' "$APP_HOME/shared/.env"
EOF
```

To add a user later, set it back to `true`, restart, let them register, then set it to `false` again.

**Connect a mailbox.** In `/app`, IMAP mailboxes work right away. Yahoo, iCloud, AOL, Zoho and Fastmail need an app password; Mail.com and GMX need IMAP switched on in their settings first. Gmail and Outlook need step 13.

## 13. Optional: "Connect Gmail" and "Connect Outlook" (OAuth)

**Domain mode with HTTPS only.** Google accepts redirect URIs only on a real domain over `https://`; plain `http://` is allowed for `localhost` and nothing else, and bare IP addresses are refused. Microsoft also allows `http://` only for `localhost`. In no-domain mode, use IMAP mailboxes.

The redirect URIs are built from `PUBLIC_BASE_URL` as `<PUBLIC_BASE_URL>/api/oauth/<provider>/callback` (`oauthRedirectUri` in `src/config.ts`). Print yours exactly, as the running app reports them:

```bash
source /etc/emailcleaner/deploy.conf
echo "Google    -> https://$DOMAIN/api/oauth/gmail/callback"
echo "Microsoft -> https://$DOMAIN/api/oauth/microsoft/callback"
curl -fsS "http://127.0.0.1:$PORT/api/providers" | grep -oE 'https?://[^ "]*/api/oauth/[a-z]+/callback' | sort -u
```

| Provider | Paste this redirect URI | Where |
| --- | --- | --- |
| Gmail / Google Workspace | `https://DOMAIN/api/oauth/gmail/callback` | Google Cloud Console → APIs & Services → Credentials → **Create credentials → OAuth client ID → Web application** → *Authorised redirect URIs* |
| Outlook / Microsoft 365 | `https://DOMAIN/api/oauth/microsoft/callback` | Microsoft Entra admin center → App registrations → your app → **Authentication → Add a platform → Web** (not "Single-page application") → *Redirect URIs* |

The URIs must match character for character: `https`, no port, no trailing slash. If you ever change `DOMAIN`, update them in both consoles.

**Google, in short** (full walkthrough: [docs/providers/gmail.md](docs/providers/gmail.md)):

1. Enable the Gmail API: <https://console.cloud.google.com/apis/library/gmail.googleapis.com>.
2. Set up the OAuth consent screen. Choose **Internal** if every user is in your Workspace, which needs no verification. Otherwise choose **External** and add test users while in Testing. Add your domain under *Authorised domains*. Use privacy policy URL `https://DOMAIN/privacy` and terms URL `https://DOMAIN/terms`.
3. Add the scopes `https://www.googleapis.com/auth/gmail.modify` (or `https://mail.google.com/` if `GOOGLE_SCOPE_LEVEL=full`) and `https://www.googleapis.com/auth/userinfo.email`.
4. Create the Web application client with the redirect URI above, and copy the client ID and secret.

**Microsoft, in short** (full walkthrough: [docs/providers/microsoft.md](docs/providers/microsoft.md)):

1. Go to <https://entra.microsoft.com> → App registrations → **New registration**. Pick the account types to match `MICROSOFT_TENANT` (`common` = any organisation + personal accounts).
2. Under the **Web** platform, add the redirect URI above.
3. Under API permissions → Microsoft Graph → Delegated, add `Mail.ReadWrite`, `User.Read` and `offline_access`.
4. Under Certificates & secrets → New client secret, copy the **Value**. It expires within at most 24 months, so put the expiry date in your calendar.

Put the values in the `.env` file:

```bash
sudo nano /opt/emailcleaner/shared/.env
# set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT
```

Restart and check what the app now reports:

```bash
source /etc/emailcleaner/deploy.conf
sudo systemctl restart emailcleaner emailcleaner-worker
sleep 3
curl -fsS "http://127.0.0.1:$PORT/api/providers" | "$APP_HOME/runtime/node/bin/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s).providers)console.log(p.id.padEnd(12),p.available?"ready":"not configured")})'
```

You should see `gmail ready` and/or `microsoft ready` (and `imap ready`).

---

## Updating

```bash
sudo /opt/emailcleaner/bin/deploy.sh
```

This pulls the latest `main`, builds it next to the running version, migrates, switches, restarts and health-checks. If anything fails before the switch, the running version is untouched. If the health check fails after the switch, it rolls back by itself.

### Changing settings later

| You changed | Then run |
| --- | --- |
| Anything in `/opt/emailcleaner/shared/.env` | `sudo systemctl restart emailcleaner emailcleaner-worker` |
| `DOMAIN` (incl. going from no-domain to a domain), `EMAIL`, `PORT` or `PUBLIC_PORT` in `deploy.conf` | Steps 9, 11 and 11b again (then update the OAuth redirect URIs if `DOMAIN` changed) |
| `BRANCH` or `REPO_URL` | `sudo /opt/emailcleaner/bin/deploy.sh` |
| `NODE_MAJOR` | `sudo rm -rf /opt/emailcleaner/runtime/node`, step 5, then `sudo /opt/emailcleaner/bin/deploy.sh` |

## Rolling back

`deploy.sh` rolls back on its own when the health check fails. To go back by hand to the previous release:

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/emailcleaner/deploy.conf
CUR=$(readlink -f "$APP_HOME/current")
PREV=$(ls -1dt "$APP_HOME"/releases/*/ | sed 's:/$::' | grep -vx "$CUR" | head -n 1 || true)
[ -n "$PREV" ] || { echo "No previous release to roll back to"; exit 1; }
ln -sfn "$PREV" "$APP_HOME/current.new" && mv -Tf "$APP_HOME/current.new" "$APP_HOME/current"
systemctl restart emailcleaner emailcleaner-worker
echo "Now running $PREV"
EOF
```

Migrations only move forward. The older code keeps running against the newer schema, which works because this project's migrations only add tables, columns and indexes. The next `deploy.sh` brings you forward again.

## Logs, status, restart

```bash
sudo systemctl status emailcleaner emailcleaner-worker --no-pager   # state of both services
sudo journalctl -u emailcleaner -f                                  # web/API log (Ctrl+C to stop)
sudo journalctl -u emailcleaner-worker -f                           # job worker log
sudo journalctl -u emailcleaner -u emailcleaner-worker --since "1 hour ago" --no-pager
sudo systemctl restart emailcleaner emailcleaner-worker             # restart both
sudo tail -f /var/log/nginx/emailcleaner.access.log /var/log/nginx/emailcleaner.error.log
```

The app also records every connect, preview, confirm, delete and undo in its own audit log; admins see recent entries on `/admin`.

## Backups and restore

Two things matter, and they must be backed up **together**:

- the database: `/opt/emailcleaner/shared/data/email-cleaner.sqlite` (users, mailboxes, rules, jobs, audit log);
- `/opt/emailcleaner/shared/.env`: it holds `ENCRYPTION_KEY`, and without that key the stored mailbox credentials in the database are unreadable.

Create a consistent backup while the app is running. This uses SQLite's online backup, which is safe with WAL; a plain `cp` is not.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/emailcleaner/deploy.conf
TS=$(date +%Y%m%d-%H%M%S); DIR="$APP_HOME/backups/$TS"
sudo -u "$APP_USER" mkdir -p "$DIR"
if grep -q '^DATABASE_URL=postgres' "$APP_HOME/shared/.env"; then
  URL=$(grep '^DATABASE_URL=' "$APP_HOME/shared/.env" | cut -d= -f2-)
  sudo -u "$APP_USER" pg_dump --format=custom --file="$DIR/emailcleaner.pgdump" "$URL"
else
  sudo -u "$APP_USER" sqlite3 "$APP_HOME/shared/data/email-cleaner.sqlite" ".backup '$DIR/email-cleaner.sqlite'"
fi
install -m 600 -o "$APP_USER" -g "$APP_USER" "$APP_HOME/shared/.env" "$DIR/.env"
tar -C "$APP_HOME/backups" -czf "$APP_HOME/backups/emailcleaner-$TS.tar.gz" "$TS"
rm -rf "$DIR"; chmod 600 "$APP_HOME/backups/emailcleaner-$TS.tar.gz"
ls -lh "$APP_HOME/backups/emailcleaner-$TS.tar.gz"
EOF
```

Copy the archive off the server, from your own computer. If you log in as a sudo user rather than root, first copy it somewhere you can read with `sudo cp` and `sudo chown`.

```bash
scp root@YOUR_SERVER_IP:'/opt/emailcleaner/backups/emailcleaner-*.tar.gz' .
```

**Restore** (SQLite). By default this restores the newest archive; set `BACKUP=` to a specific file if you want an older one.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/emailcleaner/deploy.conf
BACKUP=$(ls -1t "$APP_HOME"/backups/emailcleaner-*.tar.gz | head -n 1)
echo "Restoring $BACKUP"
TMP=$(mktemp -d); tar -xzf "$BACKUP" -C "$TMP"
systemctl stop emailcleaner emailcleaner-worker
D="$APP_HOME/shared/data"
rm -f "$D/email-cleaner.sqlite-wal" "$D/email-cleaner.sqlite-shm"
install -m 600 -o "$APP_USER" -g "$APP_USER" "$TMP"/*/email-cleaner.sqlite "$D/email-cleaner.sqlite"
install -m 600 -o "$APP_USER" -g "$APP_USER" "$TMP"/*/.env "$APP_HOME/shared/.env"
rm -rf "$TMP"
systemctl start emailcleaner emailcleaner-worker
echo "Restored. Check: curl -fsS http://127.0.0.1:$PORT/api/health"
EOF
```

With PostgreSQL, restore the dump instead: `sudo -u emailcleaner pg_restore --clean --if-exists -d "<DATABASE_URL>" emailcleaner.pgdump`, with both services stopped.

To restore onto a **new** server, follow steps 1–6 first. Then, before step 7, put the backed-up `.env` at `/opt/emailcleaner/shared/.env` (owner `emailcleaner`, mode 600), so the original `ENCRYPTION_KEY` is kept. Copy the database file into `/opt/emailcleaner/shared/data/` and continue from step 9.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Preflight: `port 3110 is used by …` | Another app already uses the port | Set `PORT=` to a free port in `deploy.conf`, then run steps 9 and 11 again. |
| `deploy.sh` fails at `git clone` / `Permission denied (publickey)` | Deploy key not added, or added to a different repo | Redo step 6, then add the key under *this* repo's **Settings → Deploy keys**. |
| `failed to start … PUBLIC_BASE_URL must be https:// in production` in the journal | No-domain mode with `NODE_ENV=production` | Run step 9 again. It sets `development` when `DOMAIN` is empty. |
| `ENCRYPTION_KEY must decode to exactly 32 bytes` | The key was edited or truncated | Restore `.env` from a backup. Only if there is no backup: generate a new key with `openssl rand -base64 32`; every mailbox must then be reconnected. |
| Mailboxes show "reconnect", or decrypt errors after a restore | `.env` and the database came from different backups | Restore both from the same archive. |
| `502 Bad Gateway` from nginx | The app isn't running or is on another port | `sudo systemctl status emailcleaner`, `sudo journalctl -u emailcleaner -n 50`; check `PORT` in `deploy.conf` matches the unit (re-run step 9). |
| Pages unstyled, links fail with `ERR_SSL_PROTOCOL_ERROR` on `http://IP:8110` | Browser upgrading to https (CSP) | Re-run step 11 with `DOMAIN` empty, which adds the CSP replacement. Clear the site's data in the browser. |
| `nginx -t` fails | Usually another site's error, or a duplicate `listen … default_server` | Read the first error line; the block already removed the emailcleaner site. Fix the named file, then re-run step 11. |
| Certbot: `DNS problem` / `unauthorized` / timeout | A record missing or wrong, Cloudflare proxy on, or port 80 closed | Check `getent ahostsv4 $DOMAIN`. Set Cloudflare to DNS only and open port 80 in ufw and your provider's firewall. Re-run 11b. |
| Live progress doesn't update | A proxy is buffering server-sent events | With nginx this is handled. Behind Cloudflare's proxy or another proxy, disable buffering there. |
| IMAP connect times out | Outbound port 993 blocked | Ask your hosting provider to open outbound 993. Test with `timeout 6 bash -c '</dev/tcp/imap.gmail.com/993' && echo open`. |
| Gmail `redirect_uri_mismatch` / Microsoft `AADSTS50011` | Redirect URI not exactly `https://DOMAIN/api/oauth/<provider>/callback` | Fix it in the console (no trailing slash, `https`). Use the step 13 command to print the exact value. |
| Google `Access blocked: app has not completed verification` | Consent screen in Testing and the address is not a test user | Add it under *Test users*, or use an Internal (Workspace) app. |
| Microsoft `AADSTS50020` | Account type doesn't match the registration | Align the app's supported account types and `MICROSOFT_TENANT`. |
| Build killed / `JavaScript heap out of memory` | Not enough RAM | Do step 3b (swap), then `sudo /opt/emailcleaner/bin/deploy.sh`. |
| `npm ci` fails compiling `better-sqlite3` | No prebuilt binary, and build tools missing | Re-run step 3 (installs `python3 make g++`), then deploy again. |
| `EACCES` / permission denied under `/opt/emailcleaner` | Files created as root by hand | `sudo chown -R emailcleaner:emailcleaner /opt/emailcleaner/shared /opt/emailcleaner/releases /opt/emailcleaner/repo` |
| `SQLITE_BUSY` / `database is locked` | A long manual `sqlite3` session holds a lock | Close it. The app waits up to 10 seconds for locks. |
| Waitlist notifications not sent | `MAIL_ENABLED=false`, or no MTA on `SMTP_HOST:SMTP_PORT` | Run a local Postfix, or leave it off (submissions still appear in `/admin`). |

## Uninstall

This removes only what this guide created: the services, the nginx site and its log files, the certificate, the optional PostgreSQL database and role, the swap file, `/opt/emailcleaner`, `/etc/emailcleaner` and the user. It removes **no packages** and doesn't touch other sites. **Make a backup first** if you might want the data.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/emailcleaner/deploy.conf
systemctl disable --now emailcleaner.service emailcleaner-worker.service 2>/dev/null || true
rm -f /etc/systemd/system/emailcleaner.service /etc/systemd/system/emailcleaner-worker.service
systemctl daemon-reload
rm -f /etc/nginx/sites-enabled/emailcleaner /etc/nginx/sites-available/emailcleaner /etc/nginx/conf.d/emailcleaner.conf
rm -f /var/log/nginx/emailcleaner.access.log* /var/log/nginx/emailcleaner.error.log*
if command -v nginx >/dev/null && systemctl is-active --quiet nginx; then nginx -t && systemctl reload nginx; fi
if [ -n "$DOMAIN" ] && command -v certbot >/dev/null; then certbot delete --cert-name "$DOMAIN" --non-interactive || true; fi
if [ -z "$DOMAIN" ] && command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw delete allow "$PUBLIC_PORT/tcp" || true; fi
if grep -q '^DATABASE_URL=postgres' "$APP_HOME/shared/.env" 2>/dev/null && command -v pg_lsclusters >/dev/null; then
  cd /
  for PGPORT in $(pg_lsclusters --no-header 2>/dev/null | awk '$4=="online" {print $3}'); do
    sudo -u postgres psql -p "$PGPORT" -qc "DROP DATABASE IF EXISTS emailcleaner" || true
    sudo -u postgres psql -p "$PGPORT" -qc "DROP ROLE IF EXISTS emailcleaner" || true
  done
fi
if [ -f /swapfile-emailcleaner ]; then
  swapoff /swapfile-emailcleaner 2>/dev/null || true
  rm -f /swapfile-emailcleaner
  sed -i '\#^/swapfile-emailcleaner #d' /etc/fstab
fi
rm -rf /opt/emailcleaner /etc/emailcleaner
id -u emailcleaner >/dev/null 2>&1 && userdel emailcleaner || true
getent group emailcleaner >/dev/null && groupdel emailcleaner || true
echo "Email Cleaner removed."
EOF
```

Finally, delete the deploy key on GitHub: **Settings → Deploy keys** of `cyberkyd01/emailcleaner-xyz`.

## Appendix: Caddy / Apache instead of nginx

Use this when ports 80/443 already belong to Caddy or Apache. Do steps 1–10 as written, skip 11 and 11b, then add one of the following. Both proxy to `127.0.0.1:3110`, the `PORT` from `deploy.conf`.

**Caddy.** Add this to your Caddyfile, usually `/etc/caddy/Caddyfile`, as a new site block, then run `sudo systemctl reload caddy`. Caddy gets the certificate itself and sends `X-Forwarded-Proto`.

```caddy
clean.example.com {
    reverse_proxy 127.0.0.1:3110 {
        flush_interval -1
    }
}
```

**Apache** (Debian/Ubuntu layout). Create `/etc/apache2/sites-available/emailcleaner.conf`:

```apache
<VirtualHost *:80>
    ServerName clean.example.com
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "expr=%{REQUEST_SCHEME}"
    ProxyPass        / http://127.0.0.1:3110/ flushpackets=on timeout=300
    ProxyPassReverse / http://127.0.0.1:3110/
    ErrorLog  ${APACHE_LOG_DIR}/emailcleaner.error.log
    CustomLog ${APACHE_LOG_DIR}/emailcleaner.access.log combined
</VirtualHost>
```

Then enable it and get the certificate. `a2enmod` makes no change if a module is already enabled.

```bash
sudo a2enmod proxy proxy_http headers
sudo a2ensite emailcleaner
sudo apache2ctl configtest && sudo systemctl reload apache2
sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get install -y --no-install-recommends certbot python3-certbot-apache
sudo certbot --apache -d clean.example.com --non-interactive --agree-tos -m you@example.com --redirect
```

`flushpackets=on` and `timeout=300` keep the live job progress (server-sent events) flowing. In no-domain mode behind Caddy or Apache, also strip `upgrade-insecure-requests` from the `Content-Security-Policy` header, as explained in step 11.
