# Outlook.com and Microsoft 365

Uses Microsoft Graph. Covers consumer accounts (outlook.com, hotmail.com,
live.com, msn.com) and work/school Microsoft 365 mailboxes through the same
registration.

---

## Operator setup

### 1. Register the application

<https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade>
→ **New registration**.

Pick the account types to match your users, and set `MICROSOFT_TENANT` to match:

| Who connects | Supported account types | `MICROSOFT_TENANT` |
| --- | --- | --- |
| Anyone, personal and work | Any org directory **and** personal Microsoft accounts | `common` |
| Outlook.com only | Personal Microsoft accounts only | `consumers` |
| Any company, no consumers | Any organizational directory | `organizations` |
| One company only | This organizational directory only | the tenant GUID |

Getting this wrong produces `AADSTS50020` (account not in directory) at sign-in.

### 2. Add the redirect URI

Platform **Web** — not *Single-page application*. A SPA registration rejects the
client secret this service uses.

```
https://your-host.example.com/api/oauth/microsoft/callback
```

It must match `PUBLIC_BASE_URL` exactly. Add
`http://localhost:8080/api/oauth/microsoft/callback` as a second entry for local
development.

### 3. Add delegated permissions

**API permissions** → **Microsoft Graph** → **Delegated permissions**:

```
Mail.ReadWrite
User.Read
offline_access
```

`Mail.ReadWrite` covers the soft delete *and* the `permanentDelete` action, so
unlike Gmail there is no separate high-privilege tier to request.

### 4. Create a client secret

**Certificates & secrets** → **New client secret**. Copy the **Value** column,
not Secret ID — the value is shown once and never again.

Secrets expire (24 months maximum). Put the expiry in a calendar; when it lapses
every connected mailbox stops refreshing.

### 5. Admin consent (work/school tenants)

If your tenant requires admin approval for third-party apps, an administrator
clicks **Grant admin consent** once on the API permissions page. Personal
Microsoft accounts consent individually and need no admin step.

### 6. Configure the service

```bash
MICROSOFT_CLIENT_ID=00000000-0000-0000-0000-000000000000
MICROSOFT_CLIENT_SECRET=…
MICROSOFT_TENANT=common
PUBLIC_BASE_URL=https://your-host.example.com
```

Restart. `GET /api/providers` should show Microsoft as `available: true`.

---

## User setup

1. Click **Connect Outlook**.
2. Sign in with the mailbox you want cleaned.
3. Accept the consent prompt.

That is all. The flow uses PKCE in addition to the client secret.

---

## How folders map

| Role | Outlook well-known folder |
| --- | --- |
| `inbox` | `inbox` |
| `spam` | `junkemail` |
| `trash` | `deleteditems` |
| `drafts` | `drafts` — protected |
| `sent` | `sentitems` — protected |
| `archive` | `archive` — protected |
| `custom` | every other folder, including nested ones |

**Outlook has no Promotions, Social, Updates or Forums.** Those roles resolve to
nothing on this provider. The preview says so explicitly rather than quietly
falling back to a broader search. Outlook's Focused/Other split is a view over
the Inbox, not a folder, so it is not selectable either.

Folder discovery walks the full tree, so nested folders like
`Inbox/Newsletters/2024` are addressable as `folder:<id>`.

---

## Behaviour and limits

These are Exchange constraints, not choices this service made. They are the main
reason the Outlook adapter is more complicated than the Gmail one.

### `$search` and `$filter` are mutually exclusive

A request cannot use both. So:

- **No keywords** → OData `$filter` on `receivedDateTime`, `isRead`,
  `hasAttachments`. Exact, ordered, unlimited paging.
- **Keywords present** → KQL `$search`. Date bounds move *into* the KQL string as
  `received:MM/DD/YYYY..MM/DD/YYYY`, and everything KQL cannot express (read
  state, attachments, starred exclusion, negative keywords) is re-checked
  locally before anything is deleted.

KQL dates are day-granular, so the exact time bounds are also re-applied locally.

### 1000 results per search, with no way to page past it

When a search window comes back full, the adapter **bisects its date range** and
searches each half, recursing until each window fits under the cap. This walks
the complete matching set without ever asking for result 1001. Bisection stops at
one-day windows; a single day with more than 1000 matches is reported as
truncated rather than silently under-deleted.

### No message size

The `messages` collection does not expose size, so `largerThanBytes` /
`smallerThanBytes` cannot be applied on this provider. The preview notes say so
rather than pretending the filter worked.

### Deletion

- **Trash** → `DELETE /me/messages/{id}`, which moves the message to Deleted
  Items. Recoverable.
- **Permanent** → `POST /me/messages/{id}/permanentDelete`, which moves it to the
  mailbox dumpster. Not visible in any client; retention policy decides how long
  it survives. Treat as irreversible.
- Both go through `$batch`, 20 sub-requests per call — Graph's hard limit. A 404
  on an individual message is treated as success, since the goal state was
  "gone".
- **Undo** moves messages from Deleted Items back to the folder they came from,
  which is recorded per message at preview time.

### Throttling

Graph throttles per mailbox. The adapter paces requests through a token bucket
and honours `Retry-After` on 429 and 503.
