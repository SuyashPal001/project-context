# Adding a New Nango-Backed Connector

_Last updated: 2026-08-14_

How to wire up a new provider integration (Slack, Notion, Jira, another
Google service, etc.) through the shared self-hosted Nango instance
(`nango-shared-infra`, live at `https://nango.projectcontext.co`), using
the Gmail pilot as the reference implementation. See
`docs/superpowers/specs/2026-08-11-nango-gmail-migration-design.md` and
`docs/superpowers/plans/2026-08-11-nango-gmail-migration.md` for the full
design/history behind this pattern.

**Why this exists:** `nango-shared-infra` exists specifically so we stop
rebuilding OAuth token exchange/storage/refresh per provider. This is the
pattern to follow instead of hand-rolling a new `integrations.<provider>.ts`
callback route the old way.

---

## Architecture (per connector)

```
Frontend                apps/api                    Nango (shared instance)         Consumer (mcp-server or elsewhere)
   │                        │                                │                                │
   │  Connect click         │                                │                                │
   ├───────────────────────►│  POST /connect/sessions        │                                │
   │                        ├───────────────────────────────►│                                │
   │  session token         │◄───────────────────────────────┤                                │
   │◄───────────────────────┤                                │                                │
   │  openConnectUI(token)  │                                │                                │
   ├────────────────────────┼───────────────────────────────►│  user authorizes with provider │
   │                        │        webhook: auth success   │                                │
   │                        │◄───────────────────────────────┤                                │
   │                        │  upsert status row, audit log  │                                │
   │                        │                                │                                │
   │                        │                                │  GET /connection/{tenantId}    │
   │                        │                                │◄───────────────────────────────┤
   │                        │                                │  live access token             │
   │                        │                                ├───────────────────────────────►│
```

Nango owns the OAuth exchange, token storage, and refresh. `apps/api` only
brokers the connect session and records connection **status** (no
credentials). Whatever code actually calls the provider's API (today:
`mcp-server`) fetches a live token from Nango directly, by tenant ID, at
call time.

---

## 1. Register the integration on the shared Nango instance

One Google/Slack/etc. OAuth app can be reused across every project on this
shared instance — the OAuth callback is always
`https://nango.projectcontext.co/oauth/callback` regardless of which
project's Nango **environment** a connection belongs to. The isolation
boundary between projects is the Nango environment + secret key, not the
underlying provider OAuth app. Only create a new provider-side OAuth app if
you specifically want different consent-screen branding per project.

1. Create (or reuse) an OAuth app in the provider's developer console
   (Google Cloud Console, Slack API dashboard, etc.), with redirect URI
   `https://nango.projectcontext.co/oauth/callback`.
2. Register it against `project-context`'s Nango environment:
   ```bash
   curl -X POST "https://nango.projectcontext.co/api/v1/integrations?env=project_context" \
     -u <dashboard-user>:<dashboard-pass> \
     -H "Content-Type: application/json" \
     -d '{"provider":"<nango-provider-slug>","integrationId":"<nango-provider-slug>","useSharedCredentials":false,"auth":{"authType":"OAUTH2","clientId":"<client id>","clientSecret":"<client secret>"}}'
   ```
   `<nango-provider-slug>` is whatever Nango's provider catalog calls it
   (`google-mail` for Gmail — check Nango's docs for the provider you need).
3. Configure a webhook URL + signing key for this environment (via the
   dashboard or API), pointing at `apps/api`'s public webhook endpoint (see
   step 3 below). Save the signing key — it becomes `NANGO_WEBHOOK_SECRET`.

Dashboard credentials and the webhook signing key are sensitive — never
commit them, never log them.

---

## 2. `apps/api` — connect session + webhook

Add (or extend, if a Nango webhook route already exists) two pieces,
following `integrations.nango.ts` / `integrations.nango.webhook.ts` as the
template:

- **Connect handler** — `POST /integrations/<provider>/connect`: same
  permission check every other connect handler in `integrations.ts` uses
  (`hasPermission(permissions, 'integrations', 'create')`), then calls
  Nango's `POST /connect/sessions` with `end_user: { id: tenantId }` and
  `allowed_integrations: ['<nango-provider-slug>']`, returns `{ token }`.
- **Webhook handler** — extend `NANGO_PROVIDER_TO_INTERNAL` in
  `integrations.nango.webhook.ts` with the new provider's Nango slug →
  this codebase's internal provider name (must match a key in
  `PROVIDER_TOOLS_MAP`, `integrations.crypto.ts`). No other webhook code
  changes — the handler is already generic across providers.

Env vars needed (same three cover every provider on this instance, already
set once for Gmail): `NANGO_HOST`, `NANGO_SECRET_KEY_PROJECT_CONTEXT`,
`NANGO_WEBHOOK_SECRET`.

---

## 3. Frontend

Add the new provider to `CONNECT_URLS`/`CATALOGUE` in
`apps/web/app/[tenant]/dashboard/integrations/_catalogue.tsx`, and add an
`entry.provider === '<provider>'` branch to `handleConnect` in `page.tsx`
mirroring the Gmail branch — `@nangohq/frontend`'s `openConnectUI` is
already a dependency, no new install needed for a second provider.

---

## 4. Whatever consumes the tokens

Add a `get<Provider>AccessToken(tenantId)` adapter next to
`mcp-server/src/integrations/nangoGmail.ts`, calling
`GET /connection/{tenantId}?provider_config_key=<nango-provider-slug>` on
`NANGO_HOST` with `NANGO_SECRET_KEY_PROJECT_CONTEXT`. Copy the error
handling (missing env vars, 404 → "no active connection", other non-2xx)
verbatim — it's already correct.

---

## Gotchas hit building the Gmail pilot (read before you hit them again)

- **`DOMAIN` on the shared instance is already a full hostname**
  (`nango.projectcontext.co`), not a bare apex domain. Never derive a new
  subdomain by string-concatenating onto `DOMAIN` (`connect.${DOMAIN}` was
  a real bug — produced `connect.nango.projectcontext.co`, which has no DNS
  record). Any new public hostname the shared instance needs gets its own
  dedicated env var and its own DNS record.
- **Cloudflare must be DNS-only (grey cloud), not proxied (orange), for
  every hostname pointing at this VM.** Proxied records serve Cloudflare's
  own wildcard cert instead of Caddy's real per-hostname Let's Encrypt
  cert — this is invisible until you inspect the cert directly (`openssl
  s_client ... | openssl x509 -noout -issuer -ext subjectAltName`; Caddy's
  own certs have `issuer=Let's Encrypt` and a SAN matching exactly one
  hostname, never a `*.` wildcard). Proxying also risks Cloudflare's WAF
  interfering with Nango's webhook POSTs to `apps/api`. Check this first
  if a new subdomain's TLS handshake fails or looks wrong.
- **`integrations.credentials_enc` and `created_by` are nullable** on
  purpose — a Nango-managed connection's status row has no credential
  material and no human actor (the webhook created it), unlike every
  other row in that table.
- **`apps/api`'s `googleConnectHandler`-style helpers stay in place** for
  providers not yet migrated to Nango — don't touch them when adding a new
  Nango-backed one. Only the specific provider you're migrating changes.
- **`@nangohq/frontend`'s `openConnectUI()` does NOT inherit `host` from
  the `new Nango({ host })` client it's called on** — it has its own
  separate `apiURL`/`baseURL` options that silently default to Nango
  Cloud (`api.nango.dev` / `connect.nango.dev`) if not passed explicitly.
  Symptom: the connect popup opens, but authorization fails with a
  confusing `invalid_client`/"OAuth client was not found" error (because
  it's asking *Nango Cloud* about an integration that only exists on our
  self-hosted instance), plus a CSP violation in the browser console
  referencing `api.nango.dev`. Always pass `apiURL: NEXT_PUBLIC_NANGO_HOST`
  and `baseURL: NEXT_PUBLIC_NANGO_CONNECT_URL` explicitly to
  `openConnectUI({...})` itself, not just to the `Nango` constructor.
