# Gmail-on-Nango Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `project-context`'s Gmail connect/token flow onto the shared self-hosted Nango instance, replacing the homegrown Google OAuth broker for Gmail only.

**Architecture:** `apps/api` creates a Nango connect session and hands the token to the frontend, which opens Nango's Connect UI via `@nangohq/frontend`; Nango owns the OAuth exchange and token storage; a new webhook on `apps/api` records connection status in Postgres (no credentials); `mcp-server` fetches live Gmail access tokens from Nango's API instead of decrypting them from Postgres itself.

**Tech Stack:** Nango (self-hosted, `nangohq/nango-server:hosted`), Hono (`apps/api`), `@modelcontextprotocol/sdk` + `googleapis` (`mcp-server`), Next.js (`apps/web`), Drizzle ORM, Vitest.

## Global Constraints

- Scope is Gmail only. Drive, Calendar, Jira, Zoho CRM/Mail/Cliq stay on the existing custom OAuth broker — do not touch their connect handlers, callback handlers, or `mcp-server`'s `db/credentials.ts` / `auth/encryption.ts` (still used by them).
- Existing tenants with a live Gmail connection under the old broker are **not** migrated — they reconnect through the new flow. Do not write migration/import code for old tokens.
- The Nango connection ID for a tenant's Gmail connection is always the tenant's `tenantId` (the identifier `apps/api` and `mcp-server` already share) — do not invent a separate mapping table.
- Never log decrypted credentials, Nango secret keys, or webhook signing secrets — follow the existing `NEVER log the return value` convention already used in `apps/api/src/routes/integrations.crypto.ts` and `mcp-server/src/auth/encryption.ts`.
- `credentials_enc` becomes nullable on `integrations` — Gmail rows written by the new webhook path have no credential material stored in Postgres.

---

### Task 1: Enable Nango Connect UI on the shared instance

**Repo:** `nango-shared-infra` (`/Users/suyash/nango-shared-infra`)

**Files:**
- Modify: `compose/docker-compose.yml`
- Modify: `compose/Caddyfile`
- Modify: `docs/runbook.md`

**Interfaces:**
- Produces: a reachable Nango Connect UI at `https://connect.${DOMAIN}`, used by Task 5's connect-session response and Task 8's frontend SDK.

Self-hosted Nango serves its Connect UI (the OAuth popup widget) from the same `nango-server` image, on an internal port, but it's off by default in this repo's compose file (`FLAG_SERVE_CONNECT_UI=false`). It needs its own origin (it's a full SPA, not something that shares a path prefix with the main API on port 3006), so it gets a dedicated subdomain proxied by Caddy — same pattern as the existing single-domain Caddy setup, just a second `site` block.

- [ ] **Step 1: Add Connect UI env vars to `nango-server`**

In `compose/docker-compose.yml`, inside the `nango-server` service's `environment:` list, add (after the existing `FLAG_SERVE_CONNECT_UI=false` line — replace it):
```yaml
      - FLAG_SERVE_CONNECT_UI=true
      - NANGO_CONNECT_UI_PORT=3009
      - NANGO_PUBLIC_CONNECT_URL=https://connect.${DOMAIN}
```

- [ ] **Step 2: Add a Caddy site block for the Connect UI subdomain**

In `compose/Caddyfile`, add a second block alongside the existing one:
```
{$DOMAIN} {
	reverse_proxy nango-server:3006
}

connect.{$DOMAIN} {
	reverse_proxy nango-server:3009
}
```

- [ ] **Step 3: Bring the stack up locally and verify both origins respond**

```bash
cd compose
cp .env.example .env   # if not already present locally; fill in required vars per docs/runbook.md
docker compose up -d
docker compose logs nango-server --tail 30   # confirm no startup errors from the new env vars
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3006/health   # expect 200
docker compose exec nango-server wget -q -O - http://localhost:3009/ | head -c 200   # expect HTML, not a connection error
```
If the 3009 check fails to return HTML, check `docker compose logs nango-server` for a Connect-UI-specific startup error before continuing — don't proceed to DNS/production changes until this local check passes.

- [ ] **Step 4: Document the new DNS requirement in the runbook**

In `docs/runbook.md`, in the "3. Point DNS at the VM" section, add a line noting a second A record is needed:
```markdown
Also create an A record for `connect.<your-domain>` pointing at the same
`vm_external_ip` — this serves Nango's Connect UI (OAuth popup widget),
enabled starting with the Gmail-on-Nango pilot. Same propagation check
applies: `dig +short connect.your-domain` should return the same IP.
```

- [ ] **Step 5: Commit**

```bash
git add compose/docker-compose.yml compose/Caddyfile docs/runbook.md
git commit -m "feat: enable Nango Connect UI for the Gmail pilot"
```

---

### Task 2: Make `integrations.credentials_enc` and `created_by` nullable

**Repo:** `project-context`

**Files:**
- Modify: `packages/foundation/database/schema/integrations.ts`
- Create: `packages/foundation/database/migrations/0052_integrations_nullable_credentials.sql` (via `drizzle-kit generate`, see Step 2)

**Interfaces:**
- Produces: `integrations.credentialsEnc` and `integrations.createdBy` both accept `null` — required by Task 6's webhook handler, which upserts a Gmail row with no credential material and no human actor (the row is created by a Nango webhook, not a form submission with a logged-in `userId`).

- [ ] **Step 1: Drop the `.notNull()` on `credentialsEnc` and `createdBy`**

In `packages/foundation/database/schema/integrations.ts`, change:
```ts
  credentialsEnc: text('credentials_enc').notNull(),
```
to:
```ts
  credentialsEnc: text('credentials_enc'),
```
and change:
```ts
  createdBy: uuid('created_by').notNull().references(() => users.id),
```
to:
```ts
  createdBy: uuid('created_by').references(() => users.id),
```

- [ ] **Step 2: Generate the migration**

```bash
cd packages/foundation/database
pnpm db:generate
```
This creates `migrations/0052_<auto-name>.sql` and updates `migrations/meta/`. Rename the generated file to `0052_integrations_nullable_credentials.sql` if drizzle-kit picks a different auto-generated name, and update the reference to it in `migrations/meta/_journal.json` (the `tag` field) to match — check the journal entry drizzle-kit just added and edit its `tag` value to the renamed filename's basename (without `.sql`).

- [ ] **Step 3: Verify the generated SQL is just the nullability change**

Open the new migration file and confirm it contains exactly:
```sql
ALTER TABLE "integrations" ALTER COLUMN "credentials_enc" DROP NOT NULL;
ALTER TABLE "integrations" ALTER COLUMN "created_by" DROP NOT NULL;
```
If drizzle-kit generated anything else (e.g. unrelated diffs from schema drift), stop and investigate before applying — don't apply an unreviewed migration.

- [ ] **Step 4: Apply the migration against a local/dev database**

```bash
pnpm db:migrate
```
Confirm it completes without error and `\d integrations` in `psql` (or equivalent) shows `credentials_enc` as nullable.

- [ ] **Step 5: Commit**

```bash
git add packages/foundation/database/schema/integrations.ts packages/foundation/database/migrations/
git commit -m "feat(db): make integrations.credentials_enc nullable for Nango-managed connections"
```

---

### Task 3: `mcp-server` Nango Gmail token adapter

**Repo:** `project-context`

**Files:**
- Create: `mcp-server/src/integrations/nangoGmail.ts`
- Test: `mcp-server/src/integrations/nangoGmail.test.ts`
- Modify: `mcp-server/.env.example`

**Interfaces:**
- Produces: `getGmailAccessToken(tenantId: string): Promise<string>` — throws `Error` with a descriptive message on any failure (no connection, Nango unreachable, non-2xx response). Consumed by Task 4.
- Consumes: `process.env.NANGO_HOST`, `process.env.NANGO_SECRET_KEY_PROJECT_CONTEXT`.

- [ ] **Step 1: Add Nango env vars to `.env.example`**

In `mcp-server/.env.example`, add:
```
# Shared self-hosted Nango instance — Gmail tokens only (see
# docs/superpowers/specs/2026-08-11-nango-gmail-migration-design.md).
NANGO_HOST=
NANGO_SECRET_KEY_PROJECT_CONTEXT=
```

- [ ] **Step 2: Write the failing test**

Create `mcp-server/src/integrations/nangoGmail.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getGmailAccessToken } from './nangoGmail';

const ORIGINAL_HOST = process.env.NANGO_HOST;
const ORIGINAL_KEY = process.env.NANGO_SECRET_KEY_PROJECT_CONTEXT;

describe('getGmailAccessToken', () => {
  beforeEach(() => {
    process.env.NANGO_HOST = 'https://nango.projectcontext.co';
    process.env.NANGO_SECRET_KEY_PROJECT_CONTEXT = 'test-secret';
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    process.env.NANGO_HOST = ORIGINAL_HOST;
    process.env.NANGO_SECRET_KEY_PROJECT_CONTEXT = ORIGINAL_KEY;
    vi.unstubAllGlobals();
  });

  it('returns the access token from a healthy connection', async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ credentials: { access_token: 'ya29.live-token' } }),
    });

    const token = await getGmailAccessToken('tenant-1');

    expect(token).toBe('ya29.live-token');
    expect(fetch).toHaveBeenCalledWith(
      'https://nango.projectcontext.co/connection/tenant-1?provider_config_key=google-mail',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-secret' }),
      }),
    );
  });

  it('throws when Nango has no connection for the tenant', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 404, text: async () => 'not found' });

    await expect(getGmailAccessToken('tenant-no-gmail')).rejects.toThrow(
      /no active Gmail connection/i,
    );
  });

  it('throws when NANGO_HOST is not configured', async () => {
    delete process.env.NANGO_HOST;
    await expect(getGmailAccessToken('tenant-1')).rejects.toThrow(/NANGO_HOST/);
  });

  it('throws when NANGO_SECRET_KEY_PROJECT_CONTEXT is not configured', async () => {
    delete process.env.NANGO_SECRET_KEY_PROJECT_CONTEXT;
    await expect(getGmailAccessToken('tenant-1')).rejects.toThrow(
      /NANGO_SECRET_KEY_PROJECT_CONTEXT/,
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd mcp-server && npx vitest run src/integrations/nangoGmail.test.ts`
Expected: FAIL — `Cannot find module './nangoGmail'`.

- [ ] **Step 4: Implement the adapter**

Create `mcp-server/src/integrations/nangoGmail.ts`:
```ts
/**
 * Fetches a live Gmail access token from the shared Nango instance.
 * Nango owns token storage/refresh for Gmail — connections are keyed by
 * tenantId (the identifier apps/api and mcp-server already share).
 */
export async function getGmailAccessToken(tenantId: string): Promise<string> {
  const host = process.env.NANGO_HOST;
  if (!host) throw new Error('NANGO_HOST env var not set');

  const secretKey = process.env.NANGO_SECRET_KEY_PROJECT_CONTEXT;
  if (!secretKey) throw new Error('NANGO_SECRET_KEY_PROJECT_CONTEXT env var not set');

  const url = `${host}/connection/${encodeURIComponent(tenantId)}?provider_config_key=google-mail`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });

  if (!resp.ok) {
    if (resp.status === 404) {
      throw new Error(`No active Gmail connection for tenant ${tenantId}`);
    }
    throw new Error(`Nango connection lookup failed with status ${resp.status}`);
  }

  const data = (await resp.json()) as { credentials?: { access_token?: string } };
  const accessToken = data.credentials?.access_token;
  if (!accessToken) {
    throw new Error(`Nango returned no access token for tenant ${tenantId}`);
  }
  return accessToken;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd mcp-server && npx vitest run src/integrations/nangoGmail.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/integrations/nangoGmail.ts mcp-server/src/integrations/nangoGmail.test.ts mcp-server/.env.example
git commit -m "feat(mcp-server): add Nango-backed Gmail token adapter"
```

---

### Task 4: Wire `mcp-server`'s Gmail tools to the Nango adapter

**Repo:** `project-context`

**Files:**
- Modify: `mcp-server/src/tools/gmail.ts:1-19`

**Interfaces:**
- Consumes: `getGmailAccessToken(tenantId: string): Promise<string>` from Task 3.

- [ ] **Step 1: Write the failing test**

There's no existing test file for `gmail.ts`'s client construction (only the tool handlers, which need a live Gmail API and aren't unit-tested today per the existing codebase). Instead, add a focused test for the swapped-out piece. Create `mcp-server/src/tools/gmail.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../integrations/nangoGmail', () => ({
  getGmailAccessToken: vi.fn(),
}));
vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: vi.fn().mockImplementation(() => ({ setCredentials: vi.fn() })) },
    gmail: vi.fn().mockReturnValue({ users: { messages: {} } }),
  },
}));

import { getGmailAccessToken } from '../integrations/nangoGmail';
import { google } from 'googleapis';

// getGmailClient isn't exported today — this test drives it indirectly via
// registerGmailTools once Step 2 below lands; see that step's note.
describe('gmail client construction uses Nango', () => {
  it('fetches the access token from Nango and sets it on the OAuth2 client', async () => {
    (getGmailAccessToken as any).mockResolvedValue('ya29.from-nango');
    const { getGmailClient } = await import('./gmail');
    await getGmailClient('tenant-1');

    expect(getGmailAccessToken).toHaveBeenCalledWith('tenant-1');
    const oauth2Instance = (google.auth.OAuth2 as any).mock.results[0].value;
    expect(oauth2Instance.setCredentials).toHaveBeenCalledWith({
      access_token: 'ya29.from-nango',
    });
  });
});
```

- [ ] **Step 2: Export `getGmailClient` and swap its implementation**

In `mcp-server/src/tools/gmail.ts`, replace lines 1-19:
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { getCredentials, refreshIfExpired, checkPolicy } from '../db/credentials';
import { assertActionAllowed } from './policy-guard';

interface ToolContext {
  tenantId: string;
  agentId?: string;
}

async function getGmailClient(tenantId: string) {
  const credentials = await getCredentials(tenantId, 'gmail');
  const accessToken = await refreshIfExpired(tenantId, 'gmail', credentials);
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.gmail({ version: 'v1', auth });
}
```
with:
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { checkPolicy } from '../db/credentials';
import { getGmailAccessToken } from '../integrations/nangoGmail';
import { assertActionAllowed } from './policy-guard';

interface ToolContext {
  tenantId: string;
  agentId?: string;
}

export async function getGmailClient(tenantId: string) {
  const accessToken = await getGmailAccessToken(tenantId);
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.gmail({ version: 'v1', auth });
}
```
Note `checkPolicy` is still imported from `../db/credentials` (unchanged — policy checks aren't part of this migration) and `getCredentials`/`refreshIfExpired` are dropped from the import since Gmail no longer uses them.

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd mcp-server && npx vitest run src/tools/gmail.test.ts`
Expected: PASS.

- [ ] **Step 4: Run the full mcp-server test suite to check for regressions**

Run: `cd mcp-server && npm test`
Expected: all existing tests (`service-auth.test.ts`, `policy-guard.test.ts`) still pass — this change doesn't touch either.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/gmail.ts mcp-server/src/tools/gmail.test.ts
git commit -m "feat(mcp-server): route Gmail tool calls through Nango token adapter"
```

---

### Task 5: `apps/api` — Nango connect session for Gmail

**Repo:** `project-context`

**Files:**
- Modify: `apps/api/src/routes/integrations.ts:42-65`
- Create: `apps/api/src/routes/integrations.nango.ts`
- Test: `apps/api/src/routes/integrations.nango.test.ts`
- Modify: `apps/api/.env.example`

**Interfaces:**
- Produces: `createNangoConnectSession(tenantId: string): Promise<{ token: string }>`, used by the new gmail connect route and reused by Task 6's webhook test setup if needed.
- Route change: `POST /integrations/google/gmail/connect` now returns `{ token: string }` instead of `{ url: string }` — this is a breaking response-shape change for that one endpoint, addressed on the frontend in Task 8.

- [ ] **Step 1: Add Nango env vars to `.env.example`**

In `apps/api/.env.example`, near the existing Google/Zoho/Jira OAuth block, add:
```
# Shared self-hosted Nango instance — Gmail only (see
# docs/superpowers/specs/2026-08-11-nango-gmail-migration-design.md).
NANGO_HOST=
NANGO_SECRET_KEY_PROJECT_CONTEXT=
NANGO_WEBHOOK_SECRET=
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/routes/integrations.nango.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createNangoConnectSession } from './integrations.nango';

const ORIGINAL_HOST = process.env.NANGO_HOST;
const ORIGINAL_KEY = process.env.NANGO_SECRET_KEY_PROJECT_CONTEXT;

describe('createNangoConnectSession', () => {
  beforeEach(() => {
    process.env.NANGO_HOST = 'https://nango.projectcontext.co';
    process.env.NANGO_SECRET_KEY_PROJECT_CONTEXT = 'test-secret';
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    process.env.NANGO_HOST = ORIGINAL_HOST;
    process.env.NANGO_SECRET_KEY_PROJECT_CONTEXT = ORIGINAL_KEY;
    vi.unstubAllGlobals();
  });

  it('creates a session scoped to google-mail for the given tenant', async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ token: 'session-tok', expires_at: '2026-08-11T20:00:00Z' }),
    });

    const result = await createNangoConnectSession('tenant-1');

    expect(result).toEqual({ token: 'session-tok' });
    expect(fetch).toHaveBeenCalledWith(
      'https://nango.projectcontext.co/connect/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-secret',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          end_user: { id: 'tenant-1' },
          allowed_integrations: ['google-mail'],
        }),
      }),
    );
  });

  it('throws when Nango rejects the request', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    await expect(createNangoConnectSession('tenant-1')).rejects.toThrow(
      /connect session creation failed/i,
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/integrations.nango.test.ts`
Expected: FAIL — `Cannot find module './integrations.nango'`.

- [ ] **Step 4: Implement `createNangoConnectSession`**

Create `apps/api/src/routes/integrations.nango.ts`:
```ts
/**
 * Creates a short-lived Nango connect session scoped to Gmail for one
 * tenant. The returned token is handed to the frontend, which opens
 * Nango's Connect UI with it — Nango owns the OAuth exchange from there.
 */
export async function createNangoConnectSession(tenantId: string): Promise<{ token: string }> {
  const host = process.env.NANGO_HOST;
  if (!host) throw new Error('NANGO_HOST env var not set');

  const secretKey = process.env.NANGO_SECRET_KEY_PROJECT_CONTEXT;
  if (!secretKey) throw new Error('NANGO_SECRET_KEY_PROJECT_CONTEXT env var not set');

  const resp = await fetch(`${host}/connect/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      end_user: { id: tenantId },
      allowed_integrations: ['google-mail'],
    }),
  });

  if (!resp.ok) {
    throw new Error(`Nango connect session creation failed with status ${resp.status}`);
  }

  const data = (await resp.json()) as { token: string };
  return { token: data.token };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/integrations.nango.test.ts`
Expected: PASS.

- [ ] **Step 6: Special-case Gmail in the connect route**

In `apps/api/src/routes/integrations.ts`, the existing `POST /google/gmail/connect` line (currently `integrationsRoutes.post('/google/gmail/connect', (c) => googleConnectHandler(c, 'gmail', 'https://www.googleapis.com/auth/gmail.modify'));`) is replaced with its own handler, since Gmail no longer goes through `googleConnectHandler`'s authorize-URL construction. `googleConnectHandler` itself is untouched — Drive and Calendar still use it.

Add the import at the top of `apps/api/src/routes/integrations.ts` (alongside the other imports):
```ts
import { createNangoConnectSession } from './integrations.nango';
```

Replace:
```ts
integrationsRoutes.post('/google/gmail/connect', (c) => googleConnectHandler(c, 'gmail', 'https://www.googleapis.com/auth/gmail.modify'));
```
with:
```ts
integrationsRoutes.post('/google/gmail/connect', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id as string;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'integrations', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    try {
        const { token } = await createNangoConnectSession(tenantId);
        return c.json({ token });
    } catch (err) {
        console.error('[google/gmail/connect] Nango session creation failed:', (err as Error).message);
        return c.json({ error: 'Failed to start Gmail connection', code: 'NANGO_ERROR' }, 502);
    }
});
```

- [ ] **Step 7: Run the full `apps/api` test suite to check for regressions**

Run: `cd apps/api && npm test`
Expected: all existing tests pass — `googleConnectHandler` (still used by Drive/Calendar) and every other route are untouched.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/integrations.nango.ts apps/api/src/routes/integrations.nango.test.ts apps/api/src/routes/integrations.ts apps/api/.env.example
git commit -m "feat(api): create Nango connect sessions for Gmail instead of a hand-built OAuth URL"
```

---

### Task 6: `apps/api` — Nango webhook receiver

**Repo:** `project-context`

**Files:**
- Create: `apps/api/src/routes/integrations.nango.webhook.ts`
- Test: `apps/api/src/routes/integrations.nango.webhook.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `PROVIDER_TOOLS_MAP` from `./integrations.crypto` (already defines `gmail`'s tool list), `syncToolsAndNotifyRelay` from `./integrations.sync`.
- Produces: mounted route `POST /integrations/webhooks/nango` on the unauthenticated `publicApi` router (same pattern as the existing GitHub webhook).

This follows the same signature-verification shape as the existing GitHub webhook (`apps/api/src/routes/integrations.github.webhook.ts`), swapping GitHub's `x-hub-signature-256` (`sha256=<hex>`) for Nango's `X-Nango-Hmac-Sha256` (plain hex digest, no prefix).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/integrations.nango.webhook.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { Hono } from 'hono';

const mockAuditInsert = vi.fn().mockReturnValue({ catch: vi.fn() });
vi.mock('@serverless-saas/database', () => ({
  db: { execute: vi.fn(), insert: vi.fn(() => ({ values: mockAuditInsert })) },
}));
vi.mock('./integrations.sync', () => ({ syncToolsAndNotifyRelay: vi.fn() }));

import { db } from '@serverless-saas/database';
import { syncToolsAndNotifyRelay } from './integrations.sync';
import { nangoWebhookRoute } from './integrations.nango.webhook';

const SECRET = 'whsec_test';
const ORIGINAL = process.env.NANGO_WEBHOOK_SECRET;

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

describe('POST /integrations/webhooks/nango', () => {
  const app = new Hono().route('/integrations', nangoWebhookRoute);

  beforeEach(() => {
    process.env.NANGO_WEBHOOK_SECRET = SECRET;
    (db.execute as any).mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.NANGO_WEBHOOK_SECRET = ORIGINAL;
    vi.clearAllMocks();
  });

  it('rejects a request with an invalid signature', async () => {
    const body = JSON.stringify({ type: 'auth', success: true });
    const res = await app.request('/integrations/webhooks/nango', {
      method: 'POST',
      headers: { 'x-nango-hmac-sha256': 'wrong', 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('rejects a request with no signature header', async () => {
    const body = JSON.stringify({ type: 'auth', success: true });
    const res = await app.request('/integrations/webhooks/nango', { method: 'POST', body });
    expect(res.status).toBe(401);
  });

  it('records the connection and syncs tools on a successful google-mail auth event', async () => {
    const payload = {
      type: 'auth',
      success: true,
      connectionId: 'tenant-1',
      providerConfigKey: 'google-mail',
    };
    const body = JSON.stringify(payload);
    const res = await app.request('/integrations/webhooks/nango', {
      method: 'POST',
      headers: { 'x-nango-hmac-sha256': sign(body), 'content-type': 'application/json' },
      body,
    });

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(mockAuditInsert).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      actorId: 'nango-webhook',
      actorType: 'system',
      action: 'integration_connected',
      resource: 'integration',
      metadata: { provider: 'gmail' },
    }));
    expect(syncToolsAndNotifyRelay).toHaveBeenCalledWith('tenant-1', 'gmail', 'add');
  });

  it('ignores a non-google-mail provider without erroring', async () => {
    const payload = { type: 'auth', success: true, connectionId: 'tenant-1', providerConfigKey: 'slack' };
    const body = JSON.stringify(payload);
    const res = await app.request('/integrations/webhooks/nango', {
      method: 'POST',
      headers: { 'x-nango-hmac-sha256': sign(body), 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    expect(db.execute).not.toHaveBeenCalled();
    expect(syncToolsAndNotifyRelay).not.toHaveBeenCalled();
  });

  it('ignores a failed auth event without writing a row', async () => {
    const payload = { type: 'auth', success: false, connectionId: 'tenant-1', providerConfigKey: 'google-mail' };
    const body = JSON.stringify(payload);
    const res = await app.request('/integrations/webhooks/nango', {
      method: 'POST',
      headers: { 'x-nango-hmac-sha256': sign(body), 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    expect(db.execute).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/integrations.nango.webhook.test.ts`
Expected: FAIL — `Cannot find module './integrations.nango.webhook'`.

- [ ] **Step 3: Implement the webhook route**

Create `apps/api/src/routes/integrations.nango.webhook.ts`:
```ts
import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { syncToolsAndNotifyRelay } from './integrations.sync';
import type { AppEnv } from '../types';

export const nangoWebhookRoute = new Hono<AppEnv>();

function verifySignature(rawBody: string, header: string | undefined, secret: string): boolean {
    if (!header) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    try { return timingSafeEqual(a, b); } catch { return false; }
}

// Maps Nango's provider_config_key back to this app's internal provider
// name used throughout the integrations table / PROVIDER_TOOLS_MAP.
// Gmail is the only entry during the pilot — see the design doc.
const NANGO_PROVIDER_TO_INTERNAL: Record<string, string> = {
    'google-mail': 'gmail',
};

nangoWebhookRoute.post('/webhooks/nango', async (c) => {
    const secret = process.env.NANGO_WEBHOOK_SECRET;
    if (!secret) {
        console.error('[nango/webhook] NANGO_WEBHOOK_SECRET not configured');
        return c.json({ error: 'not configured' }, 500);
    }

    const rawBody = await c.req.text();
    const signature = c.req.header('x-nango-hmac-sha256');

    if (!verifySignature(rawBody, signature, secret)) {
        return c.json({ error: 'invalid signature' }, 401);
    }

    let payload: any;
    try {
        payload = JSON.parse(rawBody);
    } catch {
        return c.json({ error: 'invalid json' }, 400);
    }

    if (payload.type !== 'auth' || !payload.success) {
        return c.json({ received: true, skipped: 'not a successful auth event' });
    }

    const internalProvider = NANGO_PROVIDER_TO_INTERNAL[payload.providerConfigKey];
    if (!internalProvider) {
        return c.json({ received: true, skipped: `provider=${payload.providerConfigKey}` });
    }

    const tenantId = payload.connectionId as string;
    if (!tenantId) {
        return c.json({ error: 'missing connectionId' }, 400);
    }

    try {
        await db.execute(sql`
            INSERT INTO integrations (tenant_id, provider, credentials_enc, status, permissions, created_by)
            VALUES (${tenantId}, ${internalProvider}, NULL, 'active', ARRAY[${internalProvider}]::text[], NULL)
            ON CONFLICT (tenant_id, provider) DO UPDATE SET
                credentials_enc = NULL, status = 'active',
                permissions = EXCLUDED.permissions, updated_at = NOW()
        `);
    } catch (err) {
        console.error('[nango/webhook] DB upsert failed:', (err as Error).message);
        return c.json({ error: 'db_error' }, 500);
    }

    await db.insert(auditLog).values({
        tenantId, actorId: 'nango-webhook', actorType: 'system',
        action: 'integration_connected', resource: 'integration',
        metadata: { provider: internalProvider }, traceId: c.get('traceId') ?? '',
    }).catch((err: Error) => console.error('Audit log write failed:', err));

    void syncToolsAndNotifyRelay(tenantId, internalProvider, 'add');
    return c.json({ received: true });
});
```

`created_by` is written as `NULL` — Task 2 makes that column nullable specifically for this case: a webhook-created row has no logged-in human actor to attribute it to, unlike every other insert into this table (which come from an authenticated request with a real `userId`). The audit log's `actorId`/`actorType` fields aren't FK-constrained (`audit.ts`'s `actorId` is plain `text`, and `auditActorTypeEnum` already includes `'system'` as a value), so `'nango-webhook'` / `'system'` fits the existing convention without a schema change.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/integrations.nango.webhook.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Mount the route**

In `apps/api/src/app.ts`, add the import near the other integrations imports:
```ts
import { nangoWebhookRoute } from './routes/integrations.nango.webhook';
```
And mount it on the public router near the existing webhook mounts (after `publicApi.route('/integrations', githubWebhookRoute);`):
```ts
publicApi.route('/integrations', nangoWebhookRoute);
```

- [ ] **Step 6: Run the full `apps/api` test suite to check for regressions**

Run: `cd apps/api && npm test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/integrations.nango.webhook.ts apps/api/src/routes/integrations.nango.webhook.test.ts apps/api/src/app.ts
git commit -m "feat(api): receive Nango webhooks to record Gmail connection status"
```

---

### Task 7: Remove the Gmail branch from the legacy Google OAuth callback

**Repo:** `project-context`

**Files:**
- Modify: `apps/api/src/routes/integrations.callbacks.ts:9-72`

**Interfaces:**
- None new — this only narrows an existing route's behavior.

- [ ] **Step 1: Update the type union and guard**

In `apps/api/src/routes/integrations.callbacks.ts`, change:
```ts
        const decoded = JSON.parse(Buffer.from(stateB64, 'base64').toString('utf8')) as {
            tenantId: string; userId: string; slug: string; service: 'gmail' | 'drive' | 'calendar'; ts: number;
        };
        if (Date.now() - decoded.ts > 600_000) return fail('state_expired');
        if (!['gmail', 'drive', 'calendar'].includes(decoded.service)) return fail('invalid_state');
```
to:
```ts
        const decoded = JSON.parse(Buffer.from(stateB64, 'base64').toString('utf8')) as {
            tenantId: string; userId: string; slug: string; service: 'drive' | 'calendar'; ts: number;
        };
        if (Date.now() - decoded.ts > 600_000) return fail('state_expired');
        if (!['drive', 'calendar'].includes(decoded.service)) return fail('invalid_state');
```
This is safe because `googleConnectHandler` (Task 5 confirmed unchanged) is only ever called with `'drive'` or `'calendar'` now — Gmail's connect handler no longer generates a `state` param for this callback at all, so `service` can never legitimately be `'gmail'` here again.

- [ ] **Step 2: Run the full `apps/api` test suite**

Run: `cd apps/api && npm test`
Expected: all tests pass — no existing test exercises the `gmail` branch of this callback (confirm by checking `apps/api/src/routes/**.test.ts` for `google/callback` coverage; if one exists asserting the `gmail` case, remove that specific assertion since the behavior it tested no longer exists, but leave `drive`/`calendar` coverage intact).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/integrations.callbacks.ts
git commit -m "feat(api): remove dead Gmail branch from legacy Google OAuth callback"
```

---

### Task 8: Frontend — Nango Connect UI for Gmail

**Repo:** `project-context`

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/app/[tenant]/dashboard/integrations/page.tsx:170-181`
- Modify: `apps/web/.env.example` (or wherever `NEXT_PUBLIC_*` vars are documented — check for this file's existence first; if none exists, note the var in the relevant onboarding doc instead)

**Interfaces:**
- Consumes: `POST /api/v1/integrations/google/gmail/connect` now returns `{ token: string }` (Task 5) instead of `{ url: string }`.

- [ ] **Step 1: Add the Nango frontend SDK dependency**

```bash
cd apps/web
npm install @nangohq/frontend
```

- [ ] **Step 2: Add `NEXT_PUBLIC_NANGO_HOST`**

Check whether `apps/web` has a `.env.example`:
```bash
ls apps/web/.env.example 2>/dev/null || echo "none"
```
If it exists, add:
```
NEXT_PUBLIC_NANGO_HOST=
```
If it doesn't exist, add the same line to wherever `apps/web`'s other `NEXT_PUBLIC_*` vars are documented (check `ONBOARDING.md`'s table referenced earlier in this project for the `apps/web/.env.local` entry, and add a row there instead, following that table's existing format).

- [ ] **Step 3: Special-case Gmail in `handleConnect`**

In `apps/web/app/[tenant]/dashboard/integrations/page.tsx`, add the import at the top:
```ts
import Nango from "@nangohq/frontend";
```
Replace `handleConnect` (lines 170-181):
```ts
    const handleConnect = async (entry: CatalogueEntry) => {
        const connectUrl = CONNECT_URLS[entry.provider];
        if (!connectUrl) return;
        setConnecting(entry.provider);
        try {
            const { url } = await api.post<{ url: string }>(connectUrl);
            window.location.href = url;
        } catch {
            toast.error(`Failed to start ${entry.name} connection. Please try again.`);
            setConnecting(null);
        }
    };
```
with:
```ts
    const handleConnect = async (entry: CatalogueEntry) => {
        const connectUrl = CONNECT_URLS[entry.provider];
        if (!connectUrl) return;
        setConnecting(entry.provider);

        if (entry.provider === 'gmail') {
            try {
                const { token } = await api.post<{ token: string }>(connectUrl);
                const nango = new Nango({
                    connectSessionToken: token,
                    host: process.env.NEXT_PUBLIC_NANGO_HOST,
                });
                const connectUI = nango.openConnectUI({
                    onEvent: (event) => {
                        if (event.type === 'close') {
                            setConnecting(null);
                        }
                        if (event.type === 'connect') {
                            toast.success('Gmail connected!');
                            refetch();
                            setConnecting(null);
                        }
                    },
                });
                connectUI.setSessionToken(token);
            } catch {
                toast.error('Failed to start Gmail connection. Please try again.');
                setConnecting(null);
            }
            return;
        }

        try {
            const { url } = await api.post<{ url: string }>(connectUrl);
            window.location.href = url;
        } catch {
            toast.error(`Failed to start ${entry.name} connection. Please try again.`);
            setConnecting(null);
        }
    };
```
Before running this, check the installed `@nangohq/frontend` package's TypeScript types (`node_modules/@nangohq/frontend/dist/*.d.ts` after Step 1's install) for the exact `openConnectUI` options shape and `onEvent` payload's `event.type` values — the docs fetched during design were inconsistent on exact event names, so the installed package's own types are the source of truth. Adjust the `event.type === 'close'` / `'connect'` checks to match what the types actually declare before treating this step as done.

- [ ] **Step 4: Manually verify in a browser**

Run the dev server (`npm run dev` in `apps/web`, with `apps/api` also running and pointed at a Nango instance from Task 1), navigate to the integrations page, click "Connect" on the Gmail card, and confirm the Connect UI popup opens and completes against a real Google OAuth app registered on the shared Nango instance (see Task 9 for full end-to-end setup). Confirm the "Connected!" toast appears and the card flips to its connected state without a page reload.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/package-lock.json apps/web/app/\[tenant\]/dashboard/integrations/page.tsx
git commit -m "feat(web): open Nango Connect UI for Gmail instead of redirecting to Google"
```

---

### Task 9: End-to-end verification and credential rotation

**Repo:** both

No new files — this is a verification and rollout pass, not code.

- [ ] **Step 1: Register the `google-mail` integration on the shared Nango instance**

Using a real Google OAuth app (Client ID/Secret from Google Cloud Console, with `https://connect.<domain>/oauth/callback` — confirm the exact callback path Nango expects once Task 1's Connect UI is live, per its own setup instructions — registered as an authorized redirect URI):
```bash
curl -X POST "https://<nango-domain>/api/v1/integrations?env=project_context" \
  -u <dashboard-user>:<dashboard-pass> \
  -H "Content-Type: application/json" \
  -d '{"provider":"google-mail","integrationId":"google-mail","useSharedCredentials":false,"auth":{"authType":"OAUTH2","clientId":"<real client id>","clientSecret":"<real client secret>"}}'
```
Then configure the webhook URL for this environment (pointing at `apps/api`'s public endpoint) via Nango's dashboard or API, using the signing key that matches `NANGO_WEBHOOK_SECRET` set in `apps/api`'s environment.

- [ ] **Step 2: Run the full connect flow against a real test tenant**

Through the actual `apps/web` UI (or `curl` against `apps/api` directly for the connect-session step), connect Gmail for a test tenant, authorize with a real Google account, and confirm:
- The webhook lands and `apps/api`'s logs show no errors.
- `GET /integrations` for that tenant shows Gmail as `active`.
- `mcp-server`'s `GMAIL_SEND_EMAIL` / `GMAIL_READ_EMAIL` / `GMAIL_SEARCH_EMAILS` / `GMAIL_REPLY_EMAIL` tools work against that tenant's live Gmail account.

- [ ] **Step 3: Regression-check the untouched providers**

Connect Drive, Calendar, Jira, or Zoho for the same or another test tenant and confirm those flows still work exactly as before — nothing in their code path changed, but this confirms no shared file (`integrations.ts`, `app.ts`) broke them.

- [ ] **Step 4: Rotate the shared instance's dashboard password**

Once the above is confirmed working, rotate the Nango dashboard Basic Auth password (`NANGO_DASHBOARD_PASSWORD` in `nango-shared-infra/compose/.env` on the VM), restart `nango-server` to pick it up, and confirm registering a new test integration with the new credentials still works. This closes out the credential exposed earlier in this work — it's Basic Auth used only for admin API calls, never stored in any running app's config, so rotation should require no other changes.
