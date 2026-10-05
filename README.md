# XquareSequencer

A self-hosted cold-email outreach platform (Smartlead-style): connect mailboxes, monitor domains, build drip
campaigns with an embedded editor, and manage replies from a unified inbox — with accounts, a wallet and an API.

Node 22 · Express · built-in SQLite (`node:sqlite`) · vanilla-JS SPA (no build step). Runtime deps: `express`, `nodemailer`, `imapflow`, `mailparser`.

```bash
npm install
cp .env.example .env     # set APP_SECRET at minimum
npm start                # http://localhost:3000   (first signup becomes admin)
npm test                 # end-to-end test suite (dry-send mode, in-memory DB)
```

## Features

| Area | What's there |
|---|---|
| **Accounts** | Email/password signup + login (scrypt), signed HttpOnly session cookie, CSRF header guard, login rate-limiting, **Google & Microsoft OAuth login**, profile, password change, **account deletion** (cascades all data), admin role |
| **Mailboxes** | Add **SMTP/IMAP** accounts (credentials AES-256-GCM encrypted at rest) or connect **Gmail / Outlook via OAuth2 (XOAUTH2)**; verify, pause, edit limits, signature, send test, delete. Per-mailbox daily limit and min gap; rotation across mailboxes |
| **Domains** | Add/remove domains; **registrar/availability lookup** (RDAP, optional GoDaddy API); **DNS health** (MX, SPF incl. lookup/`+all` lint, DKIM, DMARC); **DKIM key generation** + automatic DKIM signing of outgoing mail; copy-paste DNS records; **blacklist checks** across 11 DNSBLs (IPs of A/MX + domain lists) |
| **Campaigns** | 5-step builder (leads → sequence → schedule → mailboxes → review), **drip sequences** with delays, **A/B variants** with weights, threaded follow-ups, `{{var\|fallback}}` merge fields + custom CSV columns, `{spin|tax}`, timezone/day/hour windows, per-campaign daily cap, stop-on-reply, open/click tracking, one-click unsubscribe (RFC 8058), templates, duplicate, pause/resume, per-variant analytics |
| **Editor** | Embedded WYSIWYG (bold/italic/lists/links/size, variable & spintax insert, HTML source, paste cleanup, server-rendered preview with sample lead, send-test) |
| **Leads** | Lists, CSV import (quoted fields, header aliases, dedupe, 50k rows), manual add, search, global unsubscribe list |
| **Inbox** | IMAP reply polling, bounce + out-of-office detection, threaded view, reply from the right mailbox, lead labels (interested, meeting booked, …), DNC |
| **Wallet** | Micro-dollar ledger, per-email and per-check pricing, **Stripe Checkout** top-ups with verified, idempotent webhook (sandbox provider for dev), campaigns auto-pause at zero balance |
| **Activity log** | Searchable audit trail of every account/mailbox/domain/campaign/wallet action with IP |
| **API** | Every dashboard endpoint is available with `Authorization: Bearer xs_…` API keys (Settings → API keys) |
| **Dashboard** | Totals, open/reply/bounce rates, 14-day chart, onboarding checklist, health alerts |

## Configuration (`.env.example`)

- `SEND_MODE=dry|live` — **defaults to `dry`**: sends are recorded but never leave the server. Set `live` to deliver.
- `BASE_URL` — must be your public URL (tracking pixel, unsubscribe links, OAuth redirect URIs).
- OAuth redirect URIs to register: `${BASE_URL}/api/oauth/google/callback`, `${BASE_URL}/api/oauth/microsoft/callback`.
  Google needs the `https://mail.google.com/` scope (restricted: requires Google verification for public apps). Microsoft needs `SMTP.Send` and `IMAP.AccessAsUser.All` delegated permissions.
- Stripe: set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and point a webhook for `checkout.session.completed` at `${BASE_URL}/webhooks/stripe`.
- Pricing is in USD micros (`PRICE_PER_EMAIL_MICROS=2000` → $0.002).

## Architecture

```
src/
  server.js, app.js          express app, security headers/CSP, routing
  db.js                      SQLite schema (users, mailboxes, domains, leads, campaigns, steps, variants, messages, wallet, logs…)
  lib/                       security (scrypt, HMAC tokens, AES-GCM), wallet ledger, template engine, activity log, http helpers
  services/
    engine.js                scheduler (30s tick): window/limit checks, mailbox pick, render, send, advance; IMAP poll (2 min) + reply/bounce handling
    mailer.js oauth.js       SMTP/XOAUTH2 transport, DKIM signing, token refresh, tracking injection
    domains.js payments.js   RDAP/DNS/DNSBL/DKIM; Stripe + sandbox
  routes/                    auth, resources (mailboxes, domains, wallet, activity, dashboard, admin), outreach (leads, campaigns, inbox), public (tracking, unsubscribe, webhook)
public/                      SPA: index.html, styles.css, js/app.js (router), js/editor.js, js/pages/*
test/e2e.test.js             full-flow tests
```

## Honest limitations / before production

- **Verified here:** the full flow in `dry` mode via the test suite and a headless-browser walkthrough; DNS health, blacklist and DKIM generation against live DNS.
  **Not exercised against live providers** (no credentials in the build environment): real SMTP/IMAP delivery, Google/Microsoft OAuth, live Stripe, GoDaddy. The code paths are written against those APIs but expect a round of real-world testing.
- **Domain purchase** is not implemented — registrar integration is lookup/availability only.
- **Warm-up network** (peer-to-peer inbox warming) is not included; it needs a pool of cooperating mailboxes. Use conservative daily limits on new domains.
- Open tracking is inherently approximate (Apple Mail Privacy Protection, image blocking).
- Single-node by design (SQLite + in-process scheduler). For multiple instances, move to Postgres and a job queue.
- DNSBL lookups can return "inconclusive" when queried through public/shared resolvers (Spamhaus blocks them); run the server with its own resolver for reliable results.
- Sending cold email is regulated (CAN-SPAM, GDPR/PECR, CASL). Unsubscribe links and a global suppression list are built in; compliance is on the operator.
