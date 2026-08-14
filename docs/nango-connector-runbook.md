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

## Nango wraps every API response in a `data` envelope — check this for every new endpoint you call

**RESOLVED 2026-08-15.** This was the actual root cause of the issue
below, and it's a systemic pattern, not a one-off: Nango's REST API wraps
essentially all responses as `{ data: {...} }`, confirmed against Nango's
own server source for two different endpoints:
- `POST /connect/sessions` → `{ data: { token, connect_link, expires_at } }`
  (`packages/server/lib/controllers/connect/postSessions.ts:173-179`)
- `GET /connection/:id` (the modern v1 one) → `{ data: { connection: {...}, provider, endUser, errorLog } }`
  (`packages/server/lib/controllers/v1/connections/connectionId/getConnection.ts:104`)

`integrations.nango.ts`'s `createNangoConnectSession` originally read
`.token` directly off the parsed body instead of `.data.token` — this
silently produced `undefined` (not a thrown error, since the field was
just missing), which `JSON.stringify` then drops entirely, so the
response `apps/api` sent to the frontend had no `token` key at all. The
frontend faithfully forwarded that `undefined` into the Connect UI, which
Nango's own server then rejected.

**The one exception found so far**: `mcp-server`'s `getGmailAccessToken`
calls the older, `@deprecated` `GET /connection/:connectionId` route
(`routes.public.ts`, no `/v1/` prefix) — that one returns a genuinely flat
body (`res.status(200).send(response.value)` with no `data` wrapper,
`packages/server/lib/controllers/connection/connectionId/getConnection.ts:144`),
so `data.credentials?.access_token` there is correct as written. **Don't
assume this pattern is consistent** — check the exact response shape in
Nango's own source (or a real request/response, not docs summaries) for
every new endpoint before writing the parsing code, since v1 vs.
deprecated vs. public API routes don't all agree.

### Connect UI shows "This page can't be opened directly" (symptom of the bug above)

Symptom: clicking "Connect" on the Gmail card in `apps/web` opens the Nango
Connect UI popup, but it immediately shows *"This page can't be opened
directly. Please start a connection from your application."* instead of
the Google auth flow.

This message comes from `packages/connect-ui/src/views/Home.tsx` in
Nango's own source (self-hosted instance runs this same code) — it fires
when the iframe's `sessionToken` state is still `null` after a 10s
timeout (`NO_SESSION_TOKEN_TIMEOUT_MS`). Root cause confirmed via Nango's
own self-hosted server logs: the session token being sent was the literal
string `"undefined"` — see the `data`-envelope bug above, now fixed.

**Already ruled out, do not re-check these:**
- The `apps/api` connect-session endpoint itself: confirmed working,
  returns `200` with a real token (verified via Network tab).
- The Google OAuth client: confirmed valid — a raw authorize URL with a
  freshly-copied Client ID successfully reached Google's consent flow and
  redirected back to Nango's callback (got as far as Nango's own
  "No state found in callback", which is expected for a hand-built test
  URL that skips Nango's real session/state creation).
- CSP: no `Content-Security-Policy` header is sent by `apps/web` (no code
  sets one), by `connect.projectcontext.co` (checked via `curl -I`), or by
  Cloudflare (no Transform Rules on the zone — confirmed via Cloudflare's
  own AI assistant). The CSP violation seen once in console was likely a
  stale/unrelated artifact, not reproduced on retest.
- `X-Frame-Options` / `frame-ancestors`: not set anywhere in the chain —
  confirmed via `curl -I` on `connect.projectcontext.co`.
- Asset serving: the Connect UI's HTML and its entry JS bundle
  (`/assets/index-*.js`) both load correctly via direct `curl` — real
  content, correct `Content-Type`, no 404s.
- Token timing/buffering: confirmed via Nango's own SDK source
  (`connectUI.ts`) that `setSessionToken()` buffers the token if called
  before the iframe's `ready` event, then sends it once ready fires — so
  call-order relative to `openConnectUI()` isn't the issue in principle.
- **The actual deployed code differs from what's in this git branch** —
  the live bundle (confirmed by downloading and reading the real deployed
  JS chunk, not assuming from source) uses a *third* mechanism neither
  this repo's `git log` nor the earlier-proposed fix used: it constructs
  `new URL("https://connect.projectcontext.co")`, sets a `session_token`
  query param on it via `.searchParams.set(...)`, and passes that as
  `baseURL` to `openConnectUI()` — relying on `Home.tsx`'s own
  `search.get('session_token')` fallback (lines 65-71) instead of the
  postMessage-based `setSessionToken()` path. This is a legitimate,
  Nango-supported mechanism (same one used by Nango's own "Share connect
  link" feature) and traced through `Home.tsx` line by line — by that
  reading it *should* work if the token really reaches the iframe's URL.
  **Never verified: whether the token is actually present in the live
  iframe's `src` at the moment it loads** (needs real DevTools access —
  `Elements` tab, inspect the live `<iframe id="connect-ui">` element's
  `src` attribute during a real attempt, not curl or source reading).
- A separate, real, but confirmed-unrelated `401` on `GET /api/v1/integrations`
  and `GET /api/v1/integrations/composio/apps` was observed during testing —
  different endpoints entirely from the Gmail connect flow, does not block
  it (the Gmail connect `POST` succeeds independently). Still open — see
  below.

**Actual fix** (`apps/api/src/routes/integrations.nango.ts`, commit
`92f7228`): unwrap the real `{ data: { token } }` shape instead of reading
`.token` directly off the response. No DevTools access ended up being
needed — the self-hosted Nango server's own logs (tailed directly on the
VM: `docker compose logs nango-server -f` or equivalent) showed the exact
malformed request (`GET /?session_token=undefined&apiURL=...`) and
Nango's own `invalid_connect_session_token_format` error, which pointed
straight at the token never actually being set correctly upstream. If a
similar "popup stuck / silent failure" symptom shows up again for a future
provider, check the self-hosted instance's own server logs before
suspecting the browser/CSP/network layer — that's genuinely faster than
static tracing across three codebases.

The "deployed code differs from git" observation above turned out to be
a red herring from testing an in-progress VM edit mid-flight, not a real
concern — confirm with whoever's on the VM which commit is actually
running before assuming drift.

### `GET /api/v1/integrations` and `/integrations/composio/apps` return 401

Observed in the browser console during Gmail-connect testing, on a normal
authenticated dashboard page load (not specific to the Nango flow).
Confirmed unrelated to the Gmail connect popup issue above (different
endpoints; the Gmail connect `POST` succeeds independently in the same
session). Not yet investigated further — possibly related to the
`SignInResult` union-type auth fix deployed the same night
(`429b8f1`), possibly pre-existing. Check whether this reproduces outside
the Nango testing session before assuming a connection to it.
