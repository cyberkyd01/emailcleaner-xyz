# Yahoo, Mail.com, iCloud and every other IMAP mailbox

The universal fallback. Anything that speaks IMAP works here, which is what makes
"any email provider" true rather than aspirational.

---

## Operator setup

**None.** IMAP needs no OAuth client registration, so this provider is available
on every deployment out of the box. Two requirements only:

1. `ENCRYPTION_KEY` must be set — app passwords are stored encrypted at rest.
2. The host must be able to open outbound TLS connections to arbitrary IMAP
   servers on **port 993**. Restrictive egress firewalls are the single most
   common cause of "could not connect" reports.

---

## User setup, by provider

Almost every major provider now refuses plain account passwords over IMAP. The
fix is an **app password**: a generated, single-purpose credential you paste
instead of your real password. Revoking it later does not affect your account.

### Yahoo Mail

Yahoo stopped accepting account passwords over IMAP in 2024.

1. <https://login.yahoo.com/account/security>
2. **Generate and manage app passwords** → generate one, name it `Email Cleaner`.
3. Paste the 16-character value as the password here.

Yahoo files junk under **Bulk Mail**; this service maps that to the `spam` role
automatically, so a rule written for `spam` works unchanged.

Also covers `ymail.com` and `rocketmail.com`.

### Mail.com and GMX

**IMAP is switched off by default.** Turn it on first or authentication fails
with no useful explanation:

1. Sign in to the webmail.
2. **Settings** (gear icon) → **POP3 & IMAP**.
3. Tick **Enable access to this account via POP3 and IMAP**, save.

Then connect with your normal account password.

### iCloud

An app-specific password is mandatory, and two-factor authentication must already
be enabled on the Apple Account.

1. <https://appleid.apple.com> → **Sign-In and Security**.
2. **App-Specific Passwords** → generate one.
3. Paste it here.

Covers `icloud.com`, `me.com` and `mac.com`.

### AOL

App password from AOL Account Security, same as Yahoo (same infrastructure).

### Zoho, Fastmail, Yandex

Create an app password in the provider's security settings whenever two-factor
authentication is on. Fastmail: **Settings → Privacy & Security → App Passwords**.

### Gmail and Outlook.com over IMAP

Possible, but use their own providers instead — real body search, bulk
operations, and no app-password friction.

- **Gmail over IMAP** needs 2-Step Verification plus an App Password.
- **Outlook.com over IMAP** will usually be refused outright: Microsoft disabled
  IMAP basic authentication for most accounts.

### Proton Mail

Only works through **Proton Mail Bridge** running on the same host as this
service. That rules it out for shared or cloud hosting.

### Anything else

Type the address and connect. Server settings come from:

1. a built-in table of common domains, then
2. **Thunderbird's autoconfig database** (`autoconfig.thunderbird.net`), which
   covers thousands of providers, then
3. the conventional `imap.<domain>:993` guess.

If discovery gets it wrong, expand **Server settings** and enter host, port and
username manually. Some hosts want a bare username rather than the full address —
that is what the username override is for.

**The credential is tested against the live server before the account is saved.**
A wrong app password fails at connect time, not halfway through a clean.

---

## How folders map

Roles come from the IMAP `SPECIAL-USE` extension where the server publishes it:

| Special-use flag | Role |
| --- | --- |
| `\Inbox` | `inbox` |
| `\Junk` | `spam` |
| `\Trash` | `trash` |
| `\Drafts` | `drafts` — protected |
| `\Sent` | `sent` — protected |
| `\Archive`, `\All` | `archive` — protected |

Servers that do not publish special-use flags fall back to name matching, which
covers the usual vendor spellings: `Bulk Mail`, `Junk E-mail`, `Deleted Items`,
`Deleted Messages`, `Sent Items`, `Sent Mail`, `All Mail`, `Bin`. Everything else
becomes `custom` and is addressable as `folder:<path>`.

`\Noselect` folders — structural nodes that hold no mail — are skipped.

---

## Behaviour and limits

- **Keyword search** uses server-side IMAP `SEARCH`. Matching a single keyword
  or "any of several" is one search with `OR`. Matching **all** of several
  keywords runs one search per term and intersects the UID sets, because an IMAP
  search object cannot carry two `BODY` keys — this gives exact AND semantics on
  every server rather than relying on an extension.
- **Dates** use `BEFORE`/`SINCE`, which compare whole days in the *server's*
  timezone. Exact time bounds are re-applied locally before deletion.
- **Size** uses `LARGER`/`SMALLER`, widely supported.
- **Attachments** cannot be searched server-side. Candidates are checked locally
  against the fetched body structure, which costs an extra round trip.
- **Starred/flagged** exclusion is pushed to the server as `NOT FLAGGED`.
- **Trash** moves messages to the Trash folder. If the mailbox exposes no Trash
  folder at all, the job fails with a clear explanation rather than silently
  erasing mail — permanent mode has to be chosen deliberately.
- **Permanent** sets `\Deleted` and expunges.
- **Undo** moves messages from Trash back to the folder they came from. This is
  best-effort: a move assigns a new UID, so restore matches on subject within the
  Trash folder. It works for a clean immediately after a mistake; it is not a
  substitute for a backup.
- **Message ids** are `uidValidity:uid`, so a mailbox that renumbers itself
  between preview and execution is detectable rather than silently mismatched.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `rejected the credentials` | Account password used where an app password is required, or IMAP not enabled (Mail.com/GMX). |
| `Could not connect … timeout` | Outbound port 993 blocked, or a wrong host from autodiscovery. |
| `IMAP SEARCH failed in "<folder>"` | The server rejected the search — often a non-ASCII keyword. Narrow the keyword or switch the scope to subject-only. |
| Folders missing | The account is subscribed to a subset. The service lists all mailboxes, not just subscribed ones, so a genuinely missing folder means the server did not return it. |
| Spam folder not detected | The server publishes neither `\Junk` nor a recognised name. Select it explicitly as `folder:<path>`. |
