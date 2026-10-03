# Deployment: emailcleaner.xyz

> The canonical step-by-step VPS guide (Ubuntu/Debian, systemd, nginx, HTTPS) is **[DEPLOY.md](../DEPLOY.md)**. This file documents the existing openSUSE/Apache production host only.

How this service is deployed on the production VPS, and what it deliberately
does **not** touch.

## The host it shares

`158.220.123.138` (`vlcc.vicikyd.online`) is openSUSE Leap 15.6 running a live
VICIdial/Asterisk telephony stack plus several Next.js sites, MySQL, PostgreSQL,
a TURN server and Apache. Everything below is scoped so none of that is affected.

| Already on the host | Left untouched |
| --- | --- |
| Apache `httpd-prefork` on :80/:443 | One new vhost file added; never restarted, only `graceful` |
| System Node **v20.20.0** at `/usr/bin/node` | Untouched — this service ships its own Node 22 |
| Next.js apps on :3000, :3001, :3006 | Untouched |
| `node-default` on **:8080** | Untouched — this service uses :8127 instead |
| MySQL :3306, PostgreSQL :5432 | Untouched — this service uses its own SQLite file |
| Asterisk :5038/:5061/:8088/:8089, TURN :3478/:5349 | Untouched |
| `/etc/cron.d/certbot-renew` | Already existed; picks up our cert automatically |

## Layout

```
/opt/emailcleaner/
  node/          private Node v22.20.0 (tarball install, not on PATH)
  app/           application code + .env (mode 600)
  data/          SQLite database (mode 700)
  acme/          ACME HTTP-01 webroot only
```

Runs as the dedicated system user `emailcleaner` (uid 461) in its own group.
It has no login shell and owns nothing outside `/opt/emailcleaner`.

## Service

`/etc/systemd/system/emailcleaner.service` — `systemctl {status,restart,stop} emailcleaner`,
logs via `journalctl -u emailcleaner -f`.

Because this box runs production telephony, the unit is capped and hardened:

```ini
CPUQuota=60%          # cannot starve Asterisk of CPU
MemoryMax=768M
Nice=10
ProtectSystem=strict  # read-only filesystem except ReadWritePaths
ReadWritePaths=/opt/emailcleaner/data
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
```

`WORKER_CONCURRENCY=1` for the same reason — the host already sits at a load
average around 9.

## Network path

```
browser ──HTTPS──> Apache :443 (emailcleaner.xyz vhost) ──HTTP──> 127.0.0.1:8127
```

The app binds **127.0.0.1 only** (`HOST=127.0.0.1`), so it is unreachable from
the internet except through Apache. Verified: `http://158.220.123.138:8127`
refuses connections.

Vhosts, following the conventions already used on this host:

- `/etc/apache2/vhosts.d/emailcleaner.xyz.conf` — :80, serves the ACME challenge
  from disk and redirects everything else to HTTPS.
- `/etc/apache2/vhosts.d/emailcleaner.xyz-ssl.conf` — :443, terminates TLS and
  reverse-proxies to the app.

`ProxyPass ... flushpackets=on` and `ProxyTimeout 300` matter: job progress is
delivered over server-sent events, which a buffering proxy would stall.

Apache config is `configtest`-ed before every reload, and reloaded with
`apachectl graceful` so in-flight requests on the other sites are never dropped.

## TLS

Let's Encrypt via `certbot certonly --webroot -w /opt/emailcleaner/acme`,
matching the layout of the other certs on this host
(`/etc/letsencrypt/live/<domain>/`). Renewal is handled by the pre-existing
`/etc/cron.d/certbot-renew`, which renews every configured certificate — ours
included — with no extra scheduling.

The certificate covers `emailcleaner.xyz` and `www.emailcleaner.xyz`. Only
names that resolve may be included: an unresolvable SAN fails the whole ACME
order, so if you add a hostname in Cloudflare, expand the cert with

```bash
certbot certonly --webroot -w /opt/emailcleaner/acme \
  -d emailcleaner.xyz -d www.emailcleaner.xyz -d <new-name> --expand
apachectl configtest && apachectl graceful
```

The Cloudflare record is **DNS-only (grey cloud)**, so HTTP-01 validation reaches
the origin directly. If you later switch the proxy on, use SSL mode
**Full (strict)** — the origin holds a real publicly-trusted certificate, so it
will work as-is. Do not use Flexible: it would send traffic to the origin over
plain HTTP, and this service handles mailbox credentials.

## Updating

```bash
# from the project directory on your workstation
tar -czf /tmp/ec.tar.gz --exclude=node_modules --exclude=dist --exclude=data \
    --exclude=.git --exclude=.env src test scripts docs package*.json \
    tsconfig.json vitest.config.ts README.md

scp /tmp/ec.tar.gz root@158.220.123.138:/opt/emailcleaner/
ssh root@158.220.123.138 '
  export PATH=/opt/emailcleaner/node/bin:$PATH
  cd /opt/emailcleaner/app
  tar -xzf ../ec.tar.gz && rm -f ../ec.tar.gz
  npm ci --no-audit --no-fund
  npm run build
  chown -R emailcleaner:emailcleaner /opt/emailcleaner
  systemctl restart emailcleaner
  journalctl -u emailcleaner -n 20 --no-pager
'
```

`.env` is never in the archive, so secrets survive updates. Migrations run
automatically on start.

## Backups

Everything that matters is two paths:

```bash
/opt/emailcleaner/data/email-cleaner.sqlite   # accounts, rules, jobs, audit log
/opt/emailcleaner/app/.env                    # ENCRYPTION_KEY — without it the
                                              # database's credentials are junk
```

Back them up together. `ENCRYPTION_KEY` decrypts the stored OAuth refresh tokens
and IMAP app passwords; losing it means every mailbox must be reconnected.

For a consistent copy of a live SQLite database, use the backup API rather than
`cp`:

```bash
sudo -u emailcleaner /opt/emailcleaner/node/bin/node -e '
  const D = require("/opt/emailcleaner/app/node_modules/better-sqlite3");
  new D("/opt/emailcleaner/data/email-cleaner.sqlite")
    .backup(`/opt/emailcleaner/data/backup-${Date.now()}.sqlite`)
    .then(() => console.log("ok"));
'
```

## Post-deploy status

- [x] Admin account registered (`jarodglant@gmail.com`).
- [x] `ALLOW_REGISTRATION=false` — sign-ups are closed. To add a user, flip it to
      `true`, `systemctl restart emailcleaner`, register, then flip it back.
- [ ] Add Gmail/Microsoft OAuth credentials if you want those providers
      (see `docs/providers/`). IMAP works today without any.
- [ ] Rotate the root SSH password, and consider key-only authentication.

### Certificate Transparency exposure

Every Let's Encrypt certificate is published to public CT logs within seconds of
issuance, and scrapers probe brand-new domains almost immediately. Treat issuing
a certificate as publicly announcing the hostname: an internet-reachable service
with open sign-ups is discoverable from that moment, not from whenever you share
the link. Close registration before the certificate exists, or immediately
after creating the first account.
