# Gmail-on-Nango Pilot — Design

**Date:** 2026-08-11
**Status:** Approved, ready for planning
**Spans two repos:** `nango-shared-infra` (infra change) and `project-context`
(`apps/api`, `mcp-server`, frontend).

---

## Goal

Move `project-context`'s Gmail connect/token flow onto the shared self-hosted
Nango instance (`nango-shared-infra`), replacing the homegrown OAuth broker
for Gmail only, as a pilot to prove the pattern before migrating the other
six OAuth providers (Drive, Calendar, Jira, Zoho CRM/Mail/Cliq) in later,
separate passes.

---

## Problem

`project-context` runs its own per-provider OAuth broker:

- `apps/api/src/routes/integrations.ts` + `integrations.callbacks.ts` —
  connect handlers build provider authorize URLs by hand; callback handlers
  do the code-for-token exchange themselves and write encrypted tokens to a
  shared Neon Postgres `integrations` table (`tenant_id`, `provider`,
  `credentials_enc`, `status`).
- `mcp-server/src/db/credentials.ts` + `auth/encryption.ts` — reads that same
  table, decrypts with a per-tenant key derived from `TOKEN_ENCRYPTION_KEY`,
  and refreshes expired Google tokens itself via direct calls to
  `oauth2.googleapis.com/token`.

This is duplicated, provider-specific plumbing that `nango-shared-infra`
exists specifically to avoid rebuilding. Nango already handles OAuth
exchange, token storage, encryption, and refresh — `project-context` should
consume that instead of re-implementing it, at least for Gmail as the proof
case.

**Why Gmail only, not all 7 providers:** each provider (Google, Jira, Zoho)
has its own OAuth app, scopes, and consuming code — they're independent
subsystems. Migrating all of them in one pass isn't necessary to validate the
approach and would make this change much larger and riskier than it needs to
be. Drive/Calendar (same Google OAuth app as Gmail) and Jira/Zoho are
explicitly deferred to follow-up work once this pilot is proven.

**Why force-reconnect instead of migrating existing tokens:** matches the
precedent already documented in `nango-shared-infra/docs/runbook.md` for
saarthi-ai's cutover — connections made against the old instance don't carry
over, tenants reconnect. Importing raw refresh tokens into Nango via API is
possible in principle but unverified for this Nango version and adds risk
for no real benefit at pilot scale.

---

## Design

### 1. Infra change — `nango-shared-infra`

The shared instance currently runs with `FLAG_SERVE_CONNECT_UI=false`
(`compose/docker-compose.yml`), so nothing serves Nango's Connect UI (the
OAuth popup widget the frontend SDK opens). Connect UI is served by the same
`nango-server` image on an internal port (3009) — not a separate container.

Change to `compose/docker-compose.yml`:
```
FLAG_SERVE_CONNECT_UI=true
NANGO_CONNECT_UI_PORT=3009
NANGO_PUBLIC_CONNECT_URL=https://${DOMAIN}
```
Add a Caddy route proxying to `nango-server:3009` under the existing domain.
No new public port — GCP firewall stays 80/443/22-only, per the existing
design constraint in this repo's README.

This is a one-time change to the shared instance and benefits every project
on it, not just `project-context`.

### 2. `apps/api` changes

- **Connect handler** (`POST /integrations/google/gmail/connect`): instead of
  hand-building a Google authorize URL, calls Nango's
  `POST /connect/sessions` (authenticated with
  `NANGO_SECRET_KEY_PROJECT_CONTEXT`) with `end_user: { id: tenantId }` and
  `allowed_integrations: ['google-mail']`. Returns the resulting session
  token to the frontend instead of a redirect URL.
- **New webhook receiver** — `POST /integrations/webhooks/nango`: verifies
  the `X-Nango-Hmac-Sha256` header against the environment's webhook signing
  key. On a successful `google-mail` auth event, upserts a **status-only**
  row into the `integrations` table (`status: 'active'`, no
  `credentials_enc`), writes the same audit log entry
  (`integration_connected`) the old callback wrote, and calls
  `syncToolsAndNotifyRelay(tenantId, 'gmail', 'add')` — identical side
  effects to today's `googleOAuthCallbackRoute`, just triggered by Nango's
  webhook instead of Google's redirect.
- **`google/callback` route**: the `gmail` branch is removed (Nango's own
  `/oauth/callback` on the shared instance owns that leg now); `drive` and
  `calendar` branches are unchanged.
- **`GET /integrations` / entitlement counting**: unchanged — they read the
  same Postgres table, which now gets a status-only row for Gmail instead of
  one with real credentials. No consumer of that endpoint needs credential
  material, only status.

### 3. `mcp-server` changes

- New adapter function, e.g. `getGmailAccessToken(tenantId): Promise<string>`,
  that calls Nango's `GET /connection/{tenantId}?provider_config_key=google-mail`
  (using `tenantId` directly as the Nango connection ID — the identifier
  both `apps/api` and `mcp-server` already share today) and returns a live
  access token. Nango handles refresh internally.
- `tools/gmail.ts`'s `getGmailClient` switches to this adapter in place of
  `getCredentials` + `refreshIfExpired` from `db/credentials.ts`.
- `db/credentials.ts` and `auth/encryption.ts` are **not** removed — they
  stay in use for Jira/Zoho/Drive/Calendar, which are out of scope for this
  pilot.

### 4. Frontend

Adds `@nangohq/frontend`, initialized with `NEXT_PUBLIC_NANGO_HOST` pointing
at the shared instance, and opens Connect UI with the session token returned
by `apps/api`'s connect endpoint in place of the current redirect-to-Google
flow.

---

## Data flow (Gmail connect, end to end)

1. Tenant clicks "Connect Gmail" → frontend calls `apps/api`'s connect
   endpoint.
2. `apps/api` creates a Nango connect session (`end_user.id = tenantId`) →
   returns the session token.
3. Frontend opens Nango's Connect UI with that token → user authorizes with
   Google → Nango exchanges the code and stores/refreshes tokens itself,
   keyed by `connectionId = tenantId`.
4. Nango fires a webhook → `apps/api`'s `/integrations/webhooks/nango`
   verifies HMAC, upserts the status-only Postgres row, writes the audit
   log, calls `syncToolsAndNotifyRelay`.
5. Any later Gmail tool call in `mcp-server` → the new adapter calls Nango's
   `GET /connection/{tenantId}` → gets a live access token → builds the
   `google.gmail()` client exactly as today.

---

## Error handling

- **Webhook double-fire / arrives before Nango finishes provisioning**: the
  Postgres upsert uses the same `ON CONFLICT` pattern the current callback
  uses — idempotent, safe to process twice.
- **Webhook never arrives** (network blip): Gmail tool calls still work,
  since `mcp-server` talks to Nango directly and doesn't depend on the
  Postgres row — but `GET /integrations` would under-report Gmail as
  disconnected. Acceptable for a pilot; a reconciliation job is future work,
  not in this scope.
- **`mcp-server`'s Nango call fails or tenant has no connection**: the
  adapter throws, and `getGmailClient`'s caller surfaces the same `McpError`
  shape it does today (`ErrorCode.InternalError` / policy-guard denial),
  just with Nango's error as the underlying cause instead of "no active
  integration."
- **Stale pre-migration Postgres rows** for tenants who had Gmail connected
  under the old broker: left in place but ignored by the new Gmail code
  path (mcp-server no longer reads Postgres for Gmail). No migration/cleanup
  of these rows is required for the pilot; can be addressed later.

---

## Testing

- **Local infra**: bring up `nango-shared-infra`'s compose stack with
  `FLAG_SERVE_CONNECT_UI=true`, register a real `google-mail` integration
  under a test environment, confirm Connect UI loads and completes an OAuth
  round-trip against a real (or sandbox) Google OAuth app.
- **Webhook**: confirm the webhook lands, HMAC verifies, and the Postgres
  status row + audit log entry appear.
- **`mcp-server` unit test**: new adapter with a mocked Nango client
  (success, no-connection, and Nango-error cases).
- **`mcp-server` integration test**: `GMAIL_SEND_EMAIL` / `GMAIL_READ_EMAIL`
  / `GMAIL_SEARCH_EMAILS` / `GMAIL_REPLY_EMAIL` against a real connected test
  tenant end to end.
- **Regression check**: confirm Jira/Zoho/Drive/Calendar connect and token
  refresh are untouched — nothing in their code path changes.

---

## Rollout — credential rotation

Once the above is tested and working end to end, rotate the shared
instance's dashboard Basic Auth password (the value exposed in an earlier
screenshot during this work). Confirm first that nothing depends on the old
value at runtime — it's used only for admin API calls (registering
integrations, environments), never stored in any app's runtime config, so
rotation should be a no-op for already-running services.

---

## Out of scope

- Drive, Calendar, Jira, Zoho CRM/Mail/Cliq — stay on the existing custom
  OAuth broker; migrate in separate follow-up passes using this same
  pattern.
- Migrating/importing existing tenants' pre-pilot Gmail tokens into Nango —
  force-reconnect instead (see rationale above).
- Reconciliation between Nango's connection state and the Postgres
  status row if a webhook is dropped.
- Cleanup of stale pre-migration Postgres rows for Gmail.
