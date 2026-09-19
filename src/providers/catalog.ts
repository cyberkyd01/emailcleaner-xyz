import { config, oauthRedirectUri } from '../config.js';
import { knownDomains } from './imap/autodiscover.js';
import type { ProviderDescriptor } from './types.js';

/**
 * The connect flow and the docs read from this one list, so setup instructions
 * cannot drift from what the code actually requires. Every provider states what
 * the *operator* configures once and what each *end user* does per mailbox.
 */
export function providerCatalog(): ProviderDescriptor[] {
  const gmailConfigured = Boolean(config.google.clientId && config.google.clientSecret);
  const msConfigured = Boolean(config.microsoft.clientId && config.microsoft.clientSecret);

  return [
    {
      id: 'gmail',
      label: 'Gmail / Google Workspace',
      description:
        'Native Gmail API. Full-text search across the body, label-aware folders (Promotions, Social, Updates, Forums) and 1000-message bulk operations.',
      authType: 'oauth2',
      available: gmailConfigured,
      unavailableReason: gmailConfigured
        ? undefined
        : 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the server environment.',
      operatorSetup: [
        {
          title: 'Create a Google Cloud project and enable the Gmail API',
          detail:
            'Google Cloud Console > APIs & Services > Library > search "Gmail API" > Enable.',
          link: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
        },
        {
          title: 'Configure the OAuth consent screen',
          detail:
            'User type "External" for consumer Gmail, or "Internal" if every user is in your Workspace. Fill in the app name, support email, authorised domain and a privacy policy URL. Internal apps skip verification entirely, which is by far the fastest path.',
          link: 'https://console.cloud.google.com/apis/credentials/consent',
        },
        {
          title: 'Add the scopes this service uses',
          detail:
            'GOOGLE_SCOPE_LEVEL=modify requests https://www.googleapis.com/auth/gmail.modify (move to Trash) plus userinfo.email. GOOGLE_SCOPE_LEVEL=full swaps in https://mail.google.com/, which is required for permanent delete.',
        },
        {
          title: 'Create an OAuth client ID',
          detail: `Credentials > Create credentials > OAuth client ID > Web application. Add exactly this authorised redirect URI: ${oauthRedirectUri('gmail')}. Copy the client ID and secret into GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.`,
          link: 'https://console.cloud.google.com/apis/credentials',
        },
        {
          title: 'Plan for verification before going public',
          detail:
            'While the app is in Testing you may add up to 100 test users and nothing else is required. Publishing an External app with gmail.modify triggers Google review plus a CASA Tier 2 assessment; https://mail.google.com/ is a restricted scope requiring a Tier 3 assessment renewed every 12 months. Staying on GOOGLE_SCOPE_LEVEL=modify is materially cheaper.',
          link: 'https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification',
        },
      ],
      userSetup: [
        {
          title: 'Click Connect and sign in',
          detail:
            'Choose the Google account to clean and approve the permission screen. While the operator app is unpublished, the account must be listed as a test user or the sign-in is refused.',
        },
        {
          title: 'Grant the whole request',
          detail:
            'Google shows each permission with a checkbox. Unticking the Gmail permission connects the account but every clean will then fail with a permission error.',
        },
      ],
      notes: [
        config.google.scopeLevel === 'full'
          ? 'This deployment requests https://mail.google.com/, so permanent delete is available.'
          : 'This deployment requests gmail.modify, so messages are moved to Trash and stay recoverable for 30 days. Permanent delete is unavailable until GOOGLE_SCOPE_LEVEL=full.',
        'Gmail categories (Promotions, Social, Updates, Forums) are labels, so cleaning them never touches the underlying Inbox conversation twice.',
      ],
      docsPath: 'docs/providers/gmail.md',
    },

    {
      id: 'microsoft',
      label: 'Outlook.com / Microsoft 365',
      description:
        'Microsoft Graph. Covers outlook.com, hotmail.com, live.com and Microsoft 365 work accounts, including Junk Email and Deleted Items.',
      authType: 'oauth2',
      available: msConfigured,
      unavailableReason: msConfigured
        ? undefined
        : 'Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in the server environment.',
      operatorSetup: [
        {
          title: 'Register an application in Microsoft Entra ID',
          detail:
            'Entra admin centre > App registrations > New registration. For consumer Outlook.com accounts choose "Accounts in any organizational directory and personal Microsoft accounts" and set MICROSOFT_TENANT=common. For a single company, pick single-tenant and set MICROSOFT_TENANT to the tenant GUID.',
          link: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
        },
        {
          title: 'Add the redirect URI',
          detail: `Platform "Web", redirect URI ${oauthRedirectUri('microsoft')}. The platform must be Web, not SPA — a SPA registration rejects the client secret.`,
        },
        {
          title: 'Add delegated Graph permissions',
          detail:
            'API permissions > Microsoft Graph > Delegated: Mail.ReadWrite, User.Read, offline_access. Mail.ReadWrite covers both soft delete and permanentDelete, so no second consent tier is needed.',
        },
        {
          title: 'Create a client secret',
          detail:
            'Certificates & secrets > New client secret. Copy the Value (not the Secret ID) into MICROSOFT_CLIENT_SECRET. Secrets expire — diarise the renewal.',
        },
        {
          title: 'Grant admin consent (work/school tenants only)',
          detail:
            'If your tenant requires admin approval, an administrator clicks "Grant admin consent" once. Personal Microsoft accounts consent individually and need no admin step.',
        },
      ],
      userSetup: [
        {
          title: 'Click Connect and pick the account',
          detail: 'Sign in with the Outlook.com or Microsoft 365 account you want cleaned and accept the consent prompt.',
        },
      ],
      notes: [
        'Outlook has no Promotions/Social/Updates/Forums categories — those folder roles resolve to nothing on this provider, and the preview says so rather than silently widening the search.',
        'Keyword search is capped at 1000 results per query by Exchange; larger matches are collected by automatically splitting the date range.',
        'Delete moves to Deleted Items (recoverable). Permanent delete sends messages to the mailbox dumpster, where retention policy governs how long they survive.',
      ],
      docsPath: 'docs/providers/microsoft.md',
    },

    {
      id: 'imap',
      label: 'Yahoo, Mail.com, iCloud, GMX, Zoho — any IMAP mailbox',
      description:
        'Universal fallback. Server settings are discovered from the address using a built-in table plus the Thunderbird autoconfig database, so most providers need only an address and an app password.',
      authType: 'password',
      available: true,
      operatorSetup: [
        {
          title: 'Nothing to register',
          detail:
            'IMAP needs no OAuth client, so this provider works out of the box on any deployment. Only ENCRYPTION_KEY must be set, since app passwords are stored encrypted at rest.',
        },
        {
          title: 'Allow outbound port 993',
          detail:
            'The host running this service must be able to open TLS connections to arbitrary IMAP servers on port 993. Locked-down egress firewalls are the usual cause of connection timeouts.',
        },
      ],
      userSetup: [
        {
          title: 'Yahoo Mail — generate an app password',
          detail:
            'Yahoo stopped accepting account passwords over IMAP in 2024. Go to Yahoo Account Security > "Generate and manage app passwords", create one named "Email Cleaner", and paste the 16-character value here. Yahoo files spam under "Bulk Mail", which this service maps to the Spam role automatically.',
          link: 'https://login.yahoo.com/account/security',
        },
        {
          title: 'Mail.com / GMX — switch IMAP on first',
          detail:
            'IMAP is off by default. Open Settings (gear icon) > POP3 & IMAP, tick "Enable access to this account via POP3 and IMAP", and save. Then connect with your normal password.',
        },
        {
          title: 'iCloud — app-specific password required',
          detail:
            'Sign in at appleid.apple.com > Sign-In and Security > App-Specific Passwords > generate one. Two-factor authentication must already be enabled on the Apple Account.',
          link: 'https://appleid.apple.com',
        },
        {
          title: 'AOL, Zoho, Fastmail and most others',
          detail:
            'Create an app password in the provider security settings whenever two-factor authentication is on. Plain account passwords still work on providers that have not disabled basic auth.',
        },
        {
          title: 'Anything else — enter the address and test',
          detail: `Settings for ${knownDomains().length} common domains are built in, and unknown domains are looked up in the Thunderbird autoconfig database. If discovery misses, enter host and port manually; the connection is always tested before the account is saved.`,
        },
      ],
      notes: [
        'Gmail and Outlook.com are reachable over IMAP but their own providers here are strictly better — real body search, bulk operations and no app-password friction.',
        'IMAP date search has day granularity, so exact time bounds are re-checked locally before deletion.',
        'IMAP exposes no attachment flag in search, so attachment filters are applied locally after fetching message structure.',
        'Proton Mail works only through a locally running Proton Mail Bridge, which rules it out for shared hosting.',
      ],
      docsPath: 'docs/providers/imap.md',
    },
  ];
}

export const describeProvider = (id: string): ProviderDescriptor | undefined =>
  providerCatalog().find((p) => p.id === id);
