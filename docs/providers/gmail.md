# Gmail and Google Workspace

Uses the Gmail API directly. Gmail is the strongest backend here: full-text body
search server-side, real category folders, and 1000-message bulk operations.

There are two audiences below. **Operator setup** is done once by whoever runs
the service. **User setup** is what each person does when connecting a mailbox.

---

## Decide your scope level first

This choice determines how much verification work you face, so make it before
registering anything.

| | `GOOGLE_SCOPE_LEVEL=modify` (default) | `GOOGLE_SCOPE_LEVEL=full` |
| --- | --- | --- |
| OAuth scope | `.../auth/gmail.modify` | `https://mail.google.com/` |
| Google classification | Sensitive | **Restricted** |
| Can move to Trash | yes | yes |
| Can delete permanently | no | yes |
| Verification for a public app | review + CASA **Tier 2** | review + CASA **Tier 3**, annually |

Trashed mail sits in Gmail's Trash for 30 days and is recoverable, which is what
you want for a bulk cleaning tool anyway. **Start with `modify`.** Only move to
`full` if permanent deletion is a genuine requirement, and budget for the
assessment.

If every user is in your own Google Workspace, set the consent screen to
**Internal** and none of the verification applies.

---

## Operator setup

### 1. Create a project and enable the Gmail API

<https://console.cloud.google.com/apis/library/gmail.googleapis.com>

Select or create a project, then **Enable**.

### 2. Configure the OAuth consent screen

<https://console.cloud.google.com/apis/credentials/consent>

- **User type**
  - *Internal* — everyone is in your Workspace. No verification, no assessment.
    Strongly preferred if it applies.
  - *External* — consumer Gmail accounts. Verification applies when you publish.
- Fill in app name, user support email, developer contact email.
- Add your domain under **Authorised domains**.
- Provide a privacy policy URL and terms URL. Google reads these during review
  and will reject a policy that does not describe your Gmail data handling.

While the app is in **Testing** you may add up to 100 test users and use it
immediately with no review. This is the right mode for evaluation.

### 3. Add scopes

Add whichever matches your `GOOGLE_SCOPE_LEVEL`:

```
https://www.googleapis.com/auth/gmail.modify        # GOOGLE_SCOPE_LEVEL=modify
https://mail.google.com/                            # GOOGLE_SCOPE_LEVEL=full
https://www.googleapis.com/auth/userinfo.email      # always — identifies the mailbox
```

### 4. Create the OAuth client

<https://console.cloud.google.com/apis/credentials> → **Create credentials** →
**OAuth client ID** → **Web application**.

Under **Authorised redirect URIs** add exactly:

```
https://your-host.example.com/api/oauth/gmail/callback
```

This must match `PUBLIC_BASE_URL` character for character, including scheme and
any port. A trailing slash is a different URI. Add a second entry for
`http://localhost:8080/api/oauth/gmail/callback` if you develop locally.

### 5. Configure the service

```bash
GOOGLE_CLIENT_ID=…apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-…
GOOGLE_SCOPE_LEVEL=modify
PUBLIC_BASE_URL=https://your-host.example.com
```

Restart. `GET /api/providers` should now show Gmail as `available: true`.

### 6. Publishing (External apps only)

When you leave Testing:

1. Submit for verification with a demo video showing the OAuth flow and exactly
   what the app does with Gmail data.
2. Complete a CASA assessment with a Google-approved lab — Tier 2 for
   `gmail.modify`, Tier 3 for `https://mail.google.com/`.
3. Re-verify every 12 months from the assessment approval date.

Budget weeks, not days. <https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification>

---

## User setup

1. Click **Connect Gmail**.
2. Sign in with the account you want cleaned.
3. Approve the permission screen.

Two things that go wrong:

- **"Access blocked: app has not completed verification"** — the app is in
  Testing and this address is not on the test-user list. The operator adds it
  under the consent screen's Test users.
- **Unticking the Gmail checkbox** on the consent screen. The account connects,
  but every clean then fails with a permission error. Reconnect and approve all
  of it.

---

## How folders map

| Role | Gmail label |
| --- | --- |
| `inbox` | `INBOX` |
| `promotions` | `CATEGORY_PROMOTIONS` |
| `social` | `CATEGORY_SOCIAL` |
| `updates` | `CATEGORY_UPDATES` |
| `forums` | `CATEGORY_FORUMS` |
| `spam` | `SPAM` |
| `trash` | `TRASH` |
| `sent` / `drafts` / `starred` / `important` | `SENT` / `DRAFT` / `STARRED` / `IMPORTANT` — protected |
| `custom` | any user label |

Gmail labels rather than folders, so a message in Promotions is also in the
Inbox conversation. Cleaning Promotions removes it from both — that is Gmail's
own behaviour, not something this service adds.

---

## Behaviour and limits

- **Search** compiles to a Gmail `q` string. Everything expressible in the rule —
  keywords, senders, dates, size, read state, attachments, starred exclusion —
  runs server-side, so no local re-filtering is needed and previews are fast.
- **Dates** use epoch seconds rather than `before:YYYY/MM/DD`, because Gmail
  interprets bare dates as midnight **PST**, which silently shifts your window.
- **Trash** is `batchModify` with `addLabelIds: ["TRASH"]`, 1000 ids per call.
- **Permanent delete** is `batchDelete`, 1000 ids per call, and there is no undo:
  messages do not pass through Trash.
- **Undo** removes the `TRASH` label and restores `INBOX`, within
  `UNDO_WINDOW_DAYS` and Gmail's own 30-day trash retention, whichever is shorter.
- **Quota** is 250 units/second/user. The adapter spends against a token bucket
  and backs off on 429 and on the `rateLimitExceeded` flavour of 403, which is a
  rate limit rather than a permissions problem.
