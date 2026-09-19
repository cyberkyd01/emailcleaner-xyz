# OAuth verification readiness

What Google and Microsoft reviewers check, and where this deployment satisfies
it. Work through this before submitting either app for review.

---

## Google OAuth verification

Requesting `gmail.modify` makes this a **sensitive-scope** app: Google review
plus a CASA Tier 2 assessment. Requesting `https://mail.google.com/` makes it
**restricted**: Tier 3, renewed every 12 months. An **Internal** Workspace app
skips all of it.

### Homepage requirements

| Requirement | Where it is met |
| --- | --- |
| Homepage hosted on the domain that owns the OAuth client | `https://emailcleaner.xyz/` |
| Accurately explains what the app does | Landing page hero, features and "how it works" sections |
| Explains *why* Google user data is needed | `/privacy` §5.1 states each scope and its purpose |
| Visible link to the privacy policy | Footer of every page, plus the sign-up form |
| Not a login wall | `/` and all legal pages are public and server-rendered |

### Privacy policy requirements

| Requirement | Where it is met |
| --- | --- |
| Hosted on the same domain, publicly reachable, not client-rendered | `/privacy`, plain HTML in the first response |
| Names the application | §2 |
| Discloses what Google data is accessed | §3.3 |
| Discloses how it is used, stored, shared | §4, §9, §11 |
| **Limited Use disclosure, verbatim** | §5, in a call-out box |
| States data retention and deletion | §9, with a retention table and a deletion route |
| Explains how users revoke access | §5.1, links to `myaccount.google.com/permissions` |

The Limited Use paragraph is quoted in the exact wording Google requires. Do not
paraphrase it if you edit the page.

### Before submitting

- [ ] Consent screen filled in: app name, support email, developer contact,
      authorised domain, logo.
- [ ] Privacy policy URL set to `https://emailcleaner.xyz/privacy`.
- [ ] Terms of service URL set to `https://emailcleaner.xyz/terms`.
- [ ] Domain ownership verified in Google Search Console for `emailcleaner.xyz`.
- [ ] Scopes limited to what you actually use. Keep `GOOGLE_SCOPE_LEVEL=modify`
      unless permanent deletion is genuinely required — it is the difference
      between a Tier 2 and a Tier 3 assessment.
- [ ] Demo video recorded showing: the OAuth consent screen, what the app does
      with the data immediately afterwards, and the scope justification.
- [ ] Justification written for each scope. Reviewers reject vague answers; the
      text in `/privacy` §5.1 is written to be reusable here.

### Common rejection causes, and how this deployment avoids them

| Cause | Mitigation |
| --- | --- |
| Privacy policy is generic boilerplate | The policy names the actual scopes and the actual retention periods |
| Homepage does not explain the Google data use | The landing page FAQ answers "Does Email Cleaner read my emails?" directly |
| Requesting a broader scope than needed | Default is `gmail.modify`, not `mail.google.com` |
| Privacy policy behind a login or rendered by JavaScript | Served as static HTML with a 300s cache and no auth |
| No way for a user to delete their data | `/privacy` §9 gives both the in-app route and an email route |

---

## Microsoft / Outlook.com

Microsoft does not run an equivalent to CASA for delegated Mail permissions, but
**publisher verification** is expected for anything used outside your own tenant,
and the consent screen shows your privacy and terms URLs.

### Before submitting

- [ ] App registration has a privacy statement URL: `https://emailcleaner.xyz/privacy`.
- [ ] App registration has a terms of service URL: `https://emailcleaner.xyz/terms`.
- [ ] Publisher verification completed (requires a Microsoft Partner Network ID)
      so the consent screen shows "Verified" rather than "Unverified".
- [ ] Delegated permissions only — `Mail.ReadWrite`, `User.Read`,
      `offline_access`. Never request application permissions; they would grant
      access to every mailbox in a tenant.
- [ ] Redirect URI registered as platform **Web**, not SPA.
- [ ] Client secret expiry diarised.

`/privacy` §6 documents the Microsoft Graph permissions and applies the same
no-selling, no-advertising, no-AI-training commitments to Microsoft data as to
Google data.

---

## Before either review: check the live pages

```bash
# Legal pages must return content without JavaScript and without a session.
curl -s https://emailcleaner.xyz/privacy | grep -c "Limited Use"     # expect >= 1
curl -s https://emailcleaner.xyz/terms   | grep -c "Google API"      # expect >= 1

# They must be indexable and canonical.
curl -sI https://emailcleaner.xyz/privacy | grep -i x-robots-tag     # expect nothing
curl -s  https://emailcleaner.xyz/privacy | grep canonical
```

---

## Keeping the legal pages current

The user asked that these stay accurate as the product changes. When any of the
following change, update `/privacy` and `/terms` and bump the "last updated"
date at the top of each page:

| Change | Update |
| --- | --- |
| A new OAuth scope is requested | `/privacy` §5.1 or §6 scope table |
| A new provider is supported | `/privacy` §7, `/providers` page |
| Retention periods change (e.g. plan limits) | `/privacy` §9 retention table |
| A new subprocessor is introduced | `/privacy` §11 subprocessor table |
| Captcha is enabled or switched | `/privacy` §11 final paragraph |
| Plan prices or limits change | `src/services/plans.ts` only — the pricing page and API both read from it |
| A new public page is added | `PAGES` in `src/routes/pages.ts`; the sitemap picks it up automatically |

Material changes require 14 days' notice to registered users, per `/terms` §17.
