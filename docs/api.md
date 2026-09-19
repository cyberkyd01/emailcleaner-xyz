# API reference

Base URL is whatever `PUBLIC_BASE_URL` is set to. All request and response bodies
are JSON.

**Authentication** — either the `ec_session` cookie set by `/api/auth/login`, or
`Authorization: Bearer <token>` using the token that login returns. The bearer
form is there so scripts do not need a cookie jar.

**Errors** always look like this:

```json
{ "error": { "code": "bad_request", "message": "…", "details": [ … ] } }
```

`message` is safe to show a user. Codes: `bad_request`, `unauthorized`,
`forbidden`, `not_found`, `conflict`, `rate_limited`, `provider_error`,
`auth_expired`, `scope_insufficient`, `internal_error`.

---

## Auth

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/auth/register` | `{email, password}`. Password ≥ 10 chars. The first account registered becomes admin. Refused when `ALLOW_REGISTRATION=false`. |
| `POST` | `/api/auth/login` | `{email, password}` → `{user, token}`. |
| `POST` | `/api/auth/logout` | Clears the cookie. |
| `GET` | `/api/auth/me` | Current user. |
| `POST` | `/api/auth/password` | `{currentPassword, newPassword}`. |

---

## Providers and accounts

### `GET /api/providers`

Every provider with its availability and its setup steps. This is the source the
connect UI and the docs both read, so it never drifts from what the code needs.

```json
{ "providers": [ {
  "id": "imap",
  "label": "Yahoo, Mail.com, iCloud, GMX, Zoho — any IMAP mailbox",
  "authType": "password",
  "available": true,
  "operatorSetup": [ { "title": "…", "detail": "…", "link": "…" } ],
  "userSetup":     [ { "title": "…", "detail": "…" } ],
  "notes": [ "…" ],
  "docsPath": "docs/providers/imap.md"
} ] }
```

When a provider is unavailable, `unavailableReason` says which environment
variables are missing.

### `GET /api/providers/imap/discover?email=…`

IMAP settings for an address, before asking for a password.

```json
{ "settings": { "host": "imap.mail.yahoo.com", "port": 993, "secure": true,
                "source": "builtin", "guidance": "Yahoo blocks plain passwords…" } }
```

`source` is `builtin`, `ispdb` (Thunderbird autoconfig) or `manual` (a guess —
verify before trusting it). `guidance` is the provider-specific instruction to
show the user.

### `POST /api/oauth/{gmail|microsoft}/start`

Returns `{url}` to open in a popup. The popup posts a message back to the opener
on the same origin: `{type:"oauth", ok, accountId, email}` or
`{type:"oauth", ok:false, error}`.

### `POST /api/accounts/imap`

```json
{ "email": "you@yahoo.com", "password": "<app password>",
  "host": "imap.example.com", "port": 993, "username": "bare-username" }
```

Only `email` and `password` are required; the rest override autodiscovery. The
credential is tested against the live server before the account is stored.

### Other account routes

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/accounts` | Connected mailboxes and their status. |
| `GET` | `/api/accounts/{id}/folders?refresh=true` | Normalised folder list. |
| `GET` | `/api/accounts/{id}/sections` | Folders grouped by role, with counts — for a "clean sections" UI. |
| `POST` | `/api/accounts/{id}/test` | Verifies the stored credential, returns provider capabilities. |
| `PUT` | `/api/accounts/{id}/protections` | `{folders[], senders[], keywords[]}` — never-delete lists that override any rule. |
| `DELETE` | `/api/accounts/{id}` | Disconnects. Deletes no mail. |

---

## The query object

Everything about *what* to delete lives in one provider-agnostic object.

```jsonc
{
  // Folder roles and/or "folder:<remoteId>". Empty = every unprotected folder.
  "folders": ["promotions", "spam", "folder:Label_9"],

  "keywords": ["black friday", "webinar"],
  "keywordMatch": "any",            // "any" | "all"
  "keywordScope": "anywhere",       // "anywhere" | "subject" | "from" | "subject_or_from"

  "from": ["@newsletters.example"], // substring match, so a domain works
  "to": [],

  "olderThanDays": 365,
  "newerThanDays": 30,              // must be smaller than olderThanDays
  "before": "2025-01-01",           // ISO date or datetime
  "after": "2024-01-01",

  "largerThanBytes": 5242880,
  "smallerThanBytes": null,

  "readState": "any",               // "any" | "read" | "unread"
  "hasAttachment": null,

  "excludeStarred": true,           // default true
  "excludeImportant": true,         // default true
  "excludeKeywords": ["invoice", "receipt"],
  "excludeFrom": ["@bank.example"],

  "limit": 5000
}
```

Rules:

- **A query with no selector at all is rejected.** At least one of `folders`,
  `keywords`, `from`, `to`, a date bound, `largerThanBytes`, `readState` or
  `hasAttachment` must be present.
- Unknown fields are rejected, not ignored.
- Relative and absolute date bounds combine to the *tighter* window.
- Roles that do not exist on the provider are reported in `unmatchedSelectors`,
  never silently dropped.

---

## Jobs

### `POST /api/jobs/explain`

Dry run of the dry run. Resolves folders and reports what will run server-side
versus locally, without touching the mailbox. Cheap enough to call while the user
types.

```json
{ "accountId": "acc_…", "query": { … } }
```

→

```json
{
  "description": "Messages in promotions; containing any of [sale] (anywhere); excluding starred/flagged",
  "folders": [ { "remoteId": "CATEGORY_PROMOTIONS", "path": "Promotions", "role": "promotions", "messageCount": 12480 } ],
  "notes": [ "Gmail evaluates every filter server-side, including full-text body search." ],
  "warnings": [ ],
  "unmatchedSelectors": [ ],
  "requiresBodyFetch": false,
  "capabilities": { … }
}
```

### `POST /api/jobs`

```json
{ "accountId": "acc_…", "query": { … }, "mode": "trash" }
```

`mode` is `trash` (default, reversible) or `permanent`. Returns `202` with the
job in `queued`. **Nothing is deleted yet.**

### Shortcuts

`POST /api/jobs/clean-sections`

```json
{ "accountId": "acc_…", "sections": ["promotions", "social", "spam"], "olderThanDays": 90 }
```

Omitting `sections` defaults to promotions, social, updates, forums, spam, trash.

`POST /api/jobs/clean-keyword`

```json
{ "accountId": "acc_…", "keyword": "black friday", "scope": "anywhere" }
```

Omitting `sections` searches every folder except the protected ones.

### Lifecycle

```
queued → previewing → awaiting_confirm → queued_execute → running → completed
                              │                                        │
                              └── cancelled                            └── undoing → undone
```

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/jobs/{id}` | Status, counts, per-folder breakdown, sample, notes, warnings. |
| `GET` | `/api/jobs/{id}/events` | Server-sent events, one JSON job per message, closes at a terminal state. |
| `GET` | `/api/jobs/{id}/items?state=deleted` | Per-message rows. States: `matched`, `deleted`, `failed`, `restored`. |
| `POST` | `/api/jobs/{id}/confirm` | Starts the deletion. `{acknowledgeLargeDelete:true}` is required above `MAX_DELETE_PER_JOB`. |
| `POST` | `/api/jobs/{id}/cancel` | Valid until execution starts. |
| `POST` | `/api/jobs/{id}/undo` | Restores from Trash. Only for `mode:"trash"` within the undo window. |
| `GET` | `/api/jobs?accountId=…&limit=50` | History. |

`truncated: true` means more messages matched than the run could track
(`MAX_TRACKED_ITEMS`). Confirming deletes the tracked batch; run the job again to
continue.

---

## Rules

Saved queries, optionally on a schedule.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/rules?accountId=…` | |
| `POST` | `/api/rules` | `{accountId, name, query, mode, scheduleCron, autoConfirm}` |
| `PATCH` | `/api/rules/{id}` | Partial update. |
| `DELETE` | `/api/rules/{id}` | |
| `POST` | `/api/rules/{id}/run` | Queues a job now. Still previews and waits for confirmation. |

`scheduleCron` is a 5-field expression evaluated in **UTC**. `autoConfirm` skips
the manual gate on scheduled runs — but only for `mode:"trash"` and only below
`MAX_DELETE_PER_JOB`. **A scheduled rule may not use `mode:"permanent"`**; an
unattended irreversible delete is refused at creation time.

---

## Worked example

```bash
BASE=https://cleaner.example.com
TOKEN=$(curl -s -X POST $BASE/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"…"}' | jq -r .token)
AUTH="authorization: Bearer $TOKEN"

# 1. Which mailbox?
ACC=$(curl -s -H "$AUTH" $BASE/api/accounts | jq -r '.accounts[0].id')

# 2. What would this match?
curl -s -H "$AUTH" -H 'content-type: application/json' -X POST $BASE/api/jobs/explain \
  -d "{\"accountId\":\"$ACC\",\"query\":{\"keywords\":[\"black friday\"]}}" | jq .

# 3. Queue it. Nothing is deleted yet.
JOB=$(curl -s -H "$AUTH" -H 'content-type: application/json' -X POST $BASE/api/jobs/clean-keyword \
  -d "{\"accountId\":\"$ACC\",\"keyword\":\"black friday\"}" | jq -r .job.id)

# 4. Wait for the preview, then read the numbers.
until [ "$(curl -s -H "$AUTH" $BASE/api/jobs/$JOB | jq -r .job.status)" = "awaiting_confirm" ]; do sleep 2; done
curl -s -H "$AUTH" $BASE/api/jobs/$JOB | jq '.job.matched, .job.stats.byFolder, .job.stats.sample[:3]'

# 5. Approve.
curl -s -H "$AUTH" -X POST $BASE/api/jobs/$JOB/confirm

# 6. Changed your mind?
curl -s -H "$AUTH" -X POST $BASE/api/jobs/$JOB/undo
```
