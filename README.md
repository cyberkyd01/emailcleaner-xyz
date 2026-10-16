# Email Cleaner

A hosted, provider-agnostic email cleaning service.

> **Deploying to a server?** Follow the step-by-step VPS guide: **[DEPLOY.md](DEPLOY.md)**

Two things it does:

1. **Clean sections.** It detects which sections a mailbox actually has — Inbox,
   Promotions, Social, Updates, Forums, Spam/Junk, Trash — and empties the ones
   you pick.
2. **Clean by keyword.** Give it a keyword and it finds every message containing
   that keyword, across folders, and deletes those.

It works against Gmail, Outlook/Microsoft 365, Yahoo, Mail.com, iCloud, GMX,
Zoho, Fastmail and any other IMAP host, through three adapters behind one
interface.

---

## The one rule this service is built around

**Nothing is ever deleted without a preview you approved.**

Every job runs in two phases. Phase one counts matches, breaks them down by
folder, shows you a sample and tells you what the provider could and could not
do server-side. Only after you confirm does phase two delete anything. Deletes
default to *move to Trash*, which is reversible with one click for 30 days.

Other guardrails, all on by default:

| Guard | What it does |
| --- | --- |
| Protected folders | Sent, Drafts and Archive are never cleaned unless you name them explicitly. |
| Starred / flagged | Excluded from every query by default. |
| Unbounded queries | Rejected. A query with no folder, keyword, sender or date filter is refused outright. |
| Size limit | Jobs above `MAX_DELETE_PER_JOB` (default 25,000) need an explicit acknowledgement. |
| Never-delete lists | Per-account sender and keyword lists that override any rule. |
| Unprovable matches | If a message cannot be *proven* to match — unknown date, unknown size, unknown flags — it is kept, not deleted. |
| Audit log | Every connect, preview, confirm, delete and undo is recorded. |
| Scheduled rules | May only move mail to Trash. Unattended permanent deletion is refused. |

---

## Quick start

```bash
npm install
npm run keygen          # prints ENCRYPTION_KEY and SESSION_SECRET
cp .env.example .env    # paste the two keys in, then edit the rest
npm run migrate
npm run dev
```

Open <http://localhost:8080>, create an account (the first one registered becomes
the admin), and connect a mailbox.

With no OAuth credentials configured, **IMAP works immediately** — that covers
Yahoo, Mail.com, iCloud, GMX, Zoho, Fastmail and most of the long tail. Gmail and
Outlook need a one-time app registration; see below.

### Production

```bash
npm run build
npm start                 # API + worker in one process
# or, to scale the worker separately:
RUN_WORKER_IN_PROCESS=false npm start
npm run start:worker
```

Set `DATABASE_URL=postgres://…` for Postgres. SQLite is the default and needs no
setup; the schema is written to run unchanged on both.

For a complete server setup (systemd services for the API and the worker, nginx,
HTTPS, backups, updates with automatic rollback) follow [DEPLOY.md](DEPLOY.md).

---

## The website

Public pages are plain server-served HTML, not client-rendered — a crawler (and
a Google OAuth reviewer) must be able to read the content from the first
response.

| Route | Purpose |
| --- | --- |
| `/` | Landing page: what it does, how it works, FAQ |
| `/pricing` | Plans, rendered from the server's own plan definitions |
| `/providers` | Every supported provider with per-provider setup steps |
| `/security` | Credential handling and the deletion safety model |
| `/privacy` | Privacy Policy, incl. Google API Limited Use disclosure |
| `/terms` | Terms of Service |
| `/login` | Sign in / register, with 2FA and optional captcha |
| `/app` | The application (noindex) |
| `/admin` | Operations dashboard, admins only (noindex) |
| `/robots.txt`, `/sitemap.xml`, `/.well-known/security.txt` | Generated at runtime |

**SEO.** Every public page carries a unique title and description sized for what
search engines actually render, a canonical URL, Open Graph and Twitter cards,
and JSON-LD (`Organization`, `WebSite`, `SoftwareApplication`, `FAQPage`,
`Product`/`Offer`, `HowTo`, `BreadcrumbList`). `sitemap.xml` takes each page's
`lastmod` from the file's real mtime, so it stays honest as pages change, and
everything behind authentication is `Disallow`ed and sent `X-Robots-Tag:
noindex`. Set `SEO_INDEXABLE=false` on staging to suppress the lot.

## Accounts and security

- **Two-factor authentication** — TOTP (RFC 6238) with any authenticator app,
  plus ten single-use recovery codes. With 2FA on, a correct password returns a
  short-lived challenge rather than a session; the session is only issued after
  the second factor. The TOTP secret is encrypted at rest; recovery codes are
  stored hashed and burned on use. Turning 2FA off requires the password again.
- **Bot protection** — optional Google reCAPTCHA v3 or Cloudflare Turnstile on
  sign-in and registration. With `CAPTCHA_PROVIDER=none` (the default) the pages
  load no third-party script at all. If the verifier is unreachable the check
  fails open and logs loudly — a captcha outage must not lock people out of
  their own mailboxes.
- **Lockout** — failed sign-ins are recorded per identifier and locked out after
  `MAX_LOGIN_ATTEMPTS` within `LOGIN_LOCKOUT_MINUTES`. Non-existent accounts are
  hashed anyway so response timing reveals nothing.

## Plans

Plan definitions live in [src/services/plans.ts](src/services/plans.ts) and are
the single source of truth: the pricing page renders from them and the API
enforces them, so the two cannot drift.

| | Free | Pro | Business |
| --- | --- | --- | --- |
| Mailboxes | 1 | 5 | 25 |
| Jobs / 30 days | 10 | unlimited | unlimited |
| Messages / job | 5,000 | 50,000 | 250,000 |
| Scheduled rules | — | 20 | 200 |
| Undo window | 7 days | 30 days | 90 days |

Limits are checked *before* a job starts, so nothing is ever half-deleted.

## Admin dashboard

`/admin`, for accounts with the admin flag. Shows registered users, the storage
each occupies in the application database (computed from actual stored bytes,
not a row count), how active they are, their plan and quota usage, mailbox and
job counts, and messages deleted. Admins can change a plan, suspend or delete an
account, and reset someone's 2FA when they lose their authenticator.

**Administrators never see message subjects, senders or content** — the read
models return aggregates and account-level metadata only.

Charts are hand-built inline SVG. Sign-ups and jobs are different scales, so
they get one chart each rather than a dual axis, and the categorical palette is
validated for colour-vision deficiency against both light and dark surfaces.

## Provider setup

Each provider needs a slightly different setup. The service exposes the exact
steps at `GET /api/providers` and renders them in the connect UI, so the
instructions are never out of sync with what the code requires.

| Provider | What it takes | Guide |
| --- | --- | --- |
| **Gmail / Workspace** | Operator registers a Google Cloud OAuth client. Users just click Connect. | [docs/providers/gmail.md](docs/providers/gmail.md) |
| **Outlook / Microsoft 365** | Operator registers an Entra ID app. Users just click Connect. | [docs/providers/microsoft.md](docs/providers/microsoft.md) |
| **Yahoo, Mail.com, iCloud, everything else** | No operator setup. Users generate an app password. | [docs/providers/imap.md](docs/providers/imap.md) |

The short version of the per-user step:

- **Gmail / Outlook** — click Connect, sign in, approve. Nothing else.
- **Yahoo** — app password required; account passwords have been refused over
  IMAP since 2024. Yahoo Account Security → *Generate app password*.
- **Mail.com / GMX** — IMAP is **off by default**. Settings → POP3 & IMAP →
  enable it, then use your normal password.
- **iCloud** — app-specific password from appleid.apple.com. Requires 2FA.
- **AOL, Zoho, Fastmail** — app password when 2FA is on.
- **Anything else** — enter the address; server settings are discovered from a
  built-in table or Thunderbird's autoconfig database, and the connection is
  tested before the account is saved.

---

## How it stays provider-agnostic

Rules are written against **normalised folder roles**, never raw folder names:

```
inbox  promotions  social  updates  forums  spam  trash  drafts  sent  archive  starred  important  custom
```

Each adapter maps its own world onto those roles — Gmail's `CATEGORY_PROMOTIONS`
label, Outlook's `junkemail` well-known folder, Yahoo's `Bulk Mail` mailbox.
A role that does not exist on a provider (Outlook has no Promotions) resolves to
nothing and is reported, rather than silently widening the search.

A rule then compiles to whatever the provider speaks:

| | Gmail | Microsoft Graph | IMAP |
| --- | --- | --- | --- |
| Keyword search | `q=` string, full body | KQL `$search`, full body | `SEARCH BODY/TEXT` |
| Dates | epoch seconds (timezone-exact) | KQL `received:a..b` | `BEFORE`/`SINCE`, day granularity |
| Size | `larger:` / `smaller:` | not supported | `LARGER` / `SMALLER` |
| Attachments | `has:attachment` | `hasAttachments` | not supported |
| Bulk delete | 1000 ids per call | 20 per `$batch` | 200 UIDs per move |
| Result ceiling | none | **1000 per search** | none |

**Whatever a provider cannot do server-side becomes a residual filter** that this
service applies locally to every candidate before deleting it. A weaker backend
is slower, never less safe. The preview tells you which is which:

> *"Outlook cannot combine keyword search with an OData date filter, so dates are
> expressed in the search itself and re-checked locally to the exact second."*

Two consequences worth knowing:

- **Outlook's 1000-result cap** is worked around by bisecting the date range and
  searching each half, so large matches are still enumerated completely.
- **Gmail permanent delete** needs the restricted `https://mail.google.com/`
  scope (annual CASA audit). The default `gmail.modify` scope moves to Trash,
  which is what you want anyway.

---

## Architecture

```
  Browser / API client
          │
    ┌─────▼─────┐   HTTP, SSE progress
    │  Fastify  │
    └─────┬─────┘
          │
    ┌─────▼──────────────────────────┐
    │ jobs  ·  rules  ·  accounts    │   services
    └─────┬──────────────────────────┘
          │
    ┌─────▼─────┐  plan → stream → residual filter → delete
    │  engine   │
    └─────┬─────┘
          │  MailProvider interface
   ┌──────┼───────────┐
   │      │           │
 Gmail  Graph       IMAP            adapters
   │      │           │
 Google  Microsoft   Yahoo / Mail.com / iCloud / …
```

- **Queue** — jobs live in the database with a worker lease, not Redis. Cleaning
  jobs are long-running and low-frequency; one fewer moving part is worth more
  than queue throughput. Leases let a second worker take over after a crash
  without two workers ever deleting the same mail.
- **Secrets** — OAuth refresh tokens and IMAP app passwords are encrypted with
  AES-256-GCM, with the account id bound in as additional authenticated data, so
  a credential copied into another row fails to decrypt.
- **Passwords** — scrypt, no native build step.

### Layout

```
src/
  providers/        the abstraction and the three adapters
    types.ts        MailProvider, CleanQuery, FolderRole, ResidualFilter
    query.ts        validation, folder resolution, residual matching
    catalog.ts      provider descriptors + setup steps (drives UI and docs)
    gmail/ microsoft/ imap/
  services/
    engine.ts       plan → stream → filter → delete
    jobs.ts         job lifecycle, worker phases, undo
    rules.ts        saved rules and cron scheduling
    accounts.ts     credential storage, token refresh, adapter factory
  routes/           HTTP surface
  db/               Kysely, portable SQLite/Postgres schema
  web/              static single-page UI
```

---

## API

Full reference: [docs/api.md](docs/api.md). The two shortcuts that match the
headline features:

```bash
# Clean sections
curl -X POST $BASE/api/jobs/clean-sections \
  -H 'authorization: Bearer $TOKEN' -H 'content-type: application/json' \
  -d '{"accountId":"acc_…","sections":["promotions","social","spam"],"olderThanDays":90}'

# Clean by keyword, everywhere
curl -X POST $BASE/api/jobs/clean-keyword \
  -H 'authorization: Bearer $TOKEN' -H 'content-type: application/json' \
  -d '{"accountId":"acc_…","keyword":"black friday"}'
```

Both return a job in `queued`. Poll `GET /api/jobs/{id}` (or stream
`GET /api/jobs/{id}/events`) until `awaiting_confirm`, inspect the counts, then
`POST /api/jobs/{id}/confirm`.

---

## Configuration

Every option lives in [.env.example](.env.example) with a comment. The ones that
matter most:

| Variable | Default | Notes |
| --- | --- | --- |
| `ENCRYPTION_KEY` | — | Required. Losing it means every account must reconnect. |
| `SESSION_SECRET` | — | Required. |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | Must match your registered OAuth redirect URIs exactly. |
| `DATABASE_URL` | `sqlite:./data/email-cleaner.sqlite` | Or `postgres://…`. |
| `GOOGLE_SCOPE_LEVEL` | `modify` | `full` enables permanent delete and requires a CASA Tier 3 assessment. |
| `MICROSOFT_TENANT` | `common` | `consumers` for Outlook.com only, or a tenant GUID. |
| `MAX_DELETE_PER_JOB` | `25000` | Above this, confirmation needs an explicit acknowledgement. |
| `UNDO_WINDOW_DAYS` | `30` | How long a trash job stays undoable. |
| `ALLOW_REGISTRATION` | `true` | Set `false` after creating your accounts. |
| `CAPTCHA_PROVIDER` | `none` | `recaptcha`, `turnstile` or `none`. |
| `CAPTCHA_SITE_KEY` / `CAPTCHA_SECRET_KEY` | — | Required when a provider is set. |
| `MAX_LOGIN_ATTEMPTS` | `8` | Failed sign-ins before lockout. |
| `SEO_INDEXABLE` | `true` | `false` blocks all crawling — use on staging. |
| `BRAND_NAME`, `SUPPORT_EMAIL`, `PRIVACY_EMAIL` | — | Shown on the legal pages. |

---

## Tests

```bash
npm test          # 82 tests, no network access required
npm run typecheck
```

They cover query validation, per-provider query compilation, folder-role
resolution, credential encryption, TOTP (including the RFC 6238 test vector),
recovery codes, plan limits, and — with a deliberately weak stub provider — that
the engine's local filtering produces the same result a strong provider would,
including refusing to delete anything it cannot prove matched.

---

## Operational notes

- **Google verification** is the long pole for a public Gmail deployment: review
  plus a CASA Tier 2 assessment for `gmail.modify`, Tier 3 for
  `https://mail.google.com/`, renewed annually. An **Internal** Workspace app
  skips it entirely. See the Gmail guide.
- **Microsoft client secrets expire.** Diarise the renewal.
- **IMAP needs outbound port 993.** Restrictive egress firewalls are the usual
  cause of connection timeouts.
- **Proton Mail** only works through a locally running Proton Mail Bridge, which
  rules it out for shared hosting.

---

## ⭐ Support

Please give stars and if possible Buy me a coffee (USDT-TRC20) - `TA216k3WgWTrKnUKxZrSDNGzSJj3eHtEcH`

Telegram: [@Cyberkyd](https://t.me/Cyberkyd)
