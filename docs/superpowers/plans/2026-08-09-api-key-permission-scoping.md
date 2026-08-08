# API Key Permission Scoping Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `apiKeys.permissions` actually constrain what an agent-type API key can do, instead of silently granting the full permission set of the agent's membership role.

**Architecture:** Add a pure `intersectPermissions` helper next to the existing `hasPermission` in `@serverless-saas/permissions`. Use it inside `apiKeyAuthMiddleware` to narrow the role's resolved permissions down to what the key was actually scoped to, and write the result into `requestContext.permissions` — the same context field every route handler already reads via `hasPermission(requestContext.permissions, resource, action)`, regardless of whether the caller authenticated via JWT or API key. Ship a backfill migration alongside so no key already in production regresses.

**Tech Stack:** TypeScript, Hono (`createMiddleware`), Drizzle ORM, Vitest, raw-SQL Drizzle migrations.

## Global Constraints

- Effective permissions = `apiKey.permissions ∩ role.permissions`, computed fresh on every request (not cached from key creation) — spec section "Fix, part 1".
- Only `apiKeys.type === 'agent'` is in scope. `rest`/`mcp`/`oauth` types have no existing auth path and must not be touched.
- The backfill migration must only modify rows where `type = 'agent' AND status = 'active' AND permissions = '{}'` — any key with a non-empty `permissions` array already reflects someone's real choice and must not be overwritten.
- Permission strings are in `"resource:action"` format (confirmed: `apiKeys.permissions` is `text('permissions').array()`, validated at creation by `z.array(z.string()).min(1)` in `apps/api/src/routes/api-keys.ts:158`; `apiKeyAuthMiddleware` already produces role permissions in this same string format at `apps/api/src/middleware/apiKeyAuth.ts:87-89`). No object-shape conversion is needed — `hasPermission` already accepts plain strings.
- Every route handler reads permissions via `c.get('requestContext').permissions`, never `c.get('apiKeyContext')` — confirmed no route reads `apiKeyContext` for authorization. The fix must write to `requestContext`, and may leave `apiKeyContext.permissions` in place for other consumers/debugging, but it must no longer be the only place the resolved value lives.

---

## File Structure

- **Modify:** `packages/foundation/permissions/src/check.ts` — add `intersectPermissions` pure function next to `hasPermission`.
- **Create:** `packages/foundation/permissions/src/__tests__/intersectPermissions.test.ts` — unit tests for the new helper, following the existing pattern in `packages/foundation/entitlements/src/__tests__/check.test.ts`.
- **Modify:** `apps/api/src/middleware/apiKeyAuth.ts` — use `intersectPermissions`, write result to `requestContext.permissions`.
- **Create:** `apps/api/src/middleware/apiKeyAuth.test.ts` — integration-style test of the middleware's permission-narrowing behavior, with `db` mocked.
- **Modify:** `apps/api/src/middleware/tenantResolution.ts` — resolve `tenantId` from `apiKeyContext` when no JWT is present, and merge (not overwrite) `requestContext` so Task 2's `permissions` survive. (Discovered during Task 2's review — a pre-existing gap, not in the original spec.)
- **Create:** `apps/api/src/middleware/tenantResolution.test.ts` — covers agent-context resolution, unchanged JWT behavior, and the onboarding-required fallback.
- **Create:** `packages/foundation/database/migrations/0048_backfill_agent_key_permissions.sql` — backfill migration.
- **Modify:** `packages/foundation/database/migrations/meta/_journal.json` — register the new migration entry.

---

### Task 1: Add `intersectPermissions` helper

**Files:**
- Modify: `packages/foundation/permissions/src/check.ts`
- Test: `packages/foundation/permissions/src/__tests__/intersectPermissions.test.ts`

**Interfaces:**
- Produces: `intersectPermissions(keyPermissions: string[], rolePermissions: string[]): string[]` — exported from `@serverless-saas/permissions` (via existing `export * from './check'` in `packages/foundation/permissions/src/index.ts:4`). Both inputs and the return value are `"resource:action"` strings. Order of the result does not matter to callers.

- [ ] **Step 1: Write the failing test**

Create `packages/foundation/permissions/src/__tests__/intersectPermissions.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { intersectPermissions } from '../check'

describe('intersectPermissions', () => {
  it('returns only permissions present in both lists', () => {
    const keyPermissions = ['agent_tasks:create']
    const rolePermissions = ['agent_tasks:create', 'agent_tasks:delete', 'billing:read']
    expect(intersectPermissions(keyPermissions, rolePermissions)).toEqual(['agent_tasks:create'])
  })

  it('returns an empty array when there is no overlap', () => {
    const keyPermissions = ['billing:read']
    const rolePermissions = ['agent_tasks:create', 'agent_tasks:delete']
    expect(intersectPermissions(keyPermissions, rolePermissions)).toEqual([])
  })

  it('returns an empty array when the role has since lost a permission the key was scoped to', () => {
    // Role was downgraded after the key was issued — key must narrow automatically
    const keyPermissions = ['agent_tasks:create', 'billing:read']
    const rolePermissions = ['agent_tasks:create']
    expect(intersectPermissions(keyPermissions, rolePermissions)).toEqual(['agent_tasks:create'])
  })

  it('returns an empty array for an empty key permissions list', () => {
    expect(intersectPermissions([], ['agent_tasks:create'])).toEqual([])
  })

  it('does not duplicate a permission present twice in the role list', () => {
    const keyPermissions = ['agent_tasks:create']
    const rolePermissions = ['agent_tasks:create', 'agent_tasks:create']
    expect(intersectPermissions(keyPermissions, rolePermissions)).toEqual(['agent_tasks:create'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/foundation/permissions && pnpm vitest run src/__tests__/intersectPermissions.test.ts`
Expected: FAIL with `intersectPermissions is not a function` (or a TypeScript "has no exported member" error).

- [ ] **Step 3: Write minimal implementation**

Add to `packages/foundation/permissions/src/check.ts`, after `hasPermission` (after line 20):

```ts
/**
 * Narrow a set of key-scoped permission strings down to those also present
 * in the current role's permission set. Used to enforce that an API key can
 * never exceed either its own stored scope or its holder's current role.
 */
export const intersectPermissions = (
  keyPermissions: string[],
  rolePermissions: string[],
): string[] => {
  const roleSet = new Set(rolePermissions);
  const result = new Set<string>();
  for (const permission of keyPermissions) {
    if (roleSet.has(permission)) result.add(permission);
  }
  return Array.from(result);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/foundation/permissions && pnpm vitest run src/__tests__/intersectPermissions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/foundation/permissions/src/check.ts packages/foundation/permissions/src/__tests__/intersectPermissions.test.ts
git commit -m "feat(permissions): add intersectPermissions helper for API key scoping"
```

---

### Task 2: Enforce intersection in `apiKeyAuthMiddleware`

**Files:**
- Modify: `apps/api/src/middleware/apiKeyAuth.ts:80-101`
- Test: `apps/api/src/middleware/apiKeyAuth.test.ts`

**Interfaces:**
- Consumes: `intersectPermissions(keyPermissions: string[], rolePermissions: string[]): string[]` from Task 1, imported as `import { intersectPermissions } from '@serverless-saas/permissions'`.
- Produces: after this task, an agent-authenticated request has `c.get('requestContext').permissions` set to the intersected (narrowed) permission list — the same context shape `permissionsMiddleware` already produces for JWT-authenticated requests (`apps/api/src/middleware/permissions.ts:63-66`), consumed by every route handler's `hasPermission(requestContext.permissions, resource, action)` check.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/middleware/apiKeyAuth.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { apiKeyAuthMiddleware } from './apiKeyAuth'

const mockApiKeyRow = {
  id: 'key-1',
  agentId: 'agent-1',
  tenantId: 'tenant-1',
  keyHash: 'hash',
  type: 'agent' as const,
  permissions: ['agent_tasks:create'],
  status: 'active' as const,
  expiresAt: null,
}

const mockAgentRow = { id: 'agent-1', status: 'active' as const }
const mockMembershipRow = { agentId: 'agent-1', tenantId: 'tenant-1', status: 'active' as const, roleId: 'role-1' }
const mockRolePermissionRows = [
  { resource: 'agent_tasks', action: 'create' },
  { resource: 'agent_tasks', action: 'delete' },
  { resource: 'billing', action: 'read' },
]

// db.select(...).from(...).where(...).limit(1) chain — resolves in call order:
// 1. apiKeys lookup, 2. agents lookup, 3. memberships lookup, 4. permission join (no .limit)
vi.mock('@serverless-saas/database', () => {
  let call = 0
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => {
      call += 1
      if (call === 1) return Promise.resolve([mockApiKeyRow])
      if (call === 2) return Promise.resolve([mockAgentRow])
      if (call === 3) return Promise.resolve([mockMembershipRow])
      return Promise.resolve([])
    },
    then: (resolve: any) => resolve(mockRolePermissionRows), // permission join has no .limit()
  }
  return {
    db: {
      select: () => chain,
      update: () => ({ set: () => ({ where: () => ({ execute: () => Promise.resolve() }) }) }),
    },
  }
})

describe('apiKeyAuthMiddleware', () => {
  beforeEach(() => vi.clearAllMocks())

  it('narrows requestContext.permissions to the intersection of key and role permissions', async () => {
    const app = new Hono()
    app.use('*', apiKeyAuthMiddleware)
    app.get('/test', (c) => {
      const requestContext = c.get('requestContext' as never) as any
      return c.json({ permissions: requestContext?.permissions ?? null })
    })

    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer ak_testkey' },
    })
    const body = await res.json()

    // Key only grants agent_tasks:create — role also has agent_tasks:delete and
    // billing:read, but those must NOT leak through despite the role permitting them.
    expect(body.permissions).toEqual(['agent_tasks:create'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm vitest run src/middleware/apiKeyAuth.test.ts`
Expected: FAIL — `body.permissions` is `null` (nothing is written to `requestContext` yet) or the middleware crashes because the mocked chain's shape doesn't yet match what the *current* implementation calls. If it crashes rather than fails on the assertion, adjust the mock's chain calls to match the current middleware's exact query sequence in `apiKeyAuth.ts:33-84`, then re-run — the test must fail on the assertion (`permissions` not narrowed), not on a mock-shape error.

- [ ] **Step 3: Write minimal implementation**

In `apps/api/src/middleware/apiKeyAuth.ts`, add the import at the top (after line 8):

```ts
import { intersectPermissions } from '@serverless-saas/permissions';
```

Replace lines 86-98 (from `// Array of objects...` through the end of the `c.set('apiKeyContext', ...)` block) with:

```ts
    // Array of strings, "resource:action" — same format used across the whole platform
    const rolePermissions = permissionRows.map((p: { resource: string; action: string }) =>
        `${p.resource}:${p.action}`
    );

    // Narrow to what this key was actually scoped to at creation. Computed fresh
    // on every request so a later role downgrade also narrows the key automatically.
    const effectivePermissions = intersectPermissions(apiKey.permissions, rolePermissions);

    // Set apiKeyContext — key/agent metadata for other consumers
    c.set('apiKeyContext', {
        keyId: apiKey.id,
        tenantId: apiKey.tenantId,
        type: apiKey.type,
        permissions: effectivePermissions,
    });

    // Set requestContext.permissions — the field every route handler's
    // hasPermission() check reads, regardless of JWT vs API key auth
    const requestContext = (c.get('requestContext' as never) as any) ?? {};
    requestContext.permissions = effectivePermissions;
    c.set('requestContext' as never, requestContext as never);

    c.set('apiKeyId', apiKey.id);
    c.set('agentId', agent.id);
    c.set('actorType', 'agent');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && pnpm vitest run src/middleware/apiKeyAuth.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full apps/api test suite to check for regressions**

Run: `cd apps/api && pnpm vitest run`
Expected: PASS — no other test depended on the old `apiKeyContext`-only behavior (confirmed during investigation: no route reads `apiKeyContext` directly).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/middleware/apiKeyAuth.ts apps/api/src/middleware/apiKeyAuth.test.ts
git commit -m "fix(api): enforce apiKeys.permissions scope instead of granting full role"
```

---

### Task 3: Resolve tenant from `apiKeyContext` for agent-authenticated requests

**Why this task exists (discovered during Task 2's review, not in the original spec):**
`tenantResolutionMiddleware` (`apps/api/src/middleware/tenantResolution.ts:26-27`) resolves `tenantId`
exclusively from `c.get('jwtPayload')?.['custom:tenantId']`. `authInjectionMiddleware` explicitly never
sets `jwtPayload` for `ak_`-prefixed keys (`apps/api/src/middleware/authInjection.ts:43-45`, deferring to
`apiKeyAuthMiddleware`), and `apiKeyAuthMiddleware` never sets `jwtPayload` either. Result: every
agent-authenticated request hits `tenantResolutionMiddleware`'s `!tenantId` branch, which **overwrites**
`requestContext` to `{ needsOnboarding: true }` (wiping out the `permissions` Task 2 set) and returns a
403 `ONBOARDING_REQUIRED` before the request reaches `permissionsMiddleware` or any route handler. This
is pre-existing and blocks Task 2's fix from ever taking effect on a real request — agent API key auth
does not work end-to-end without this fix.

**Files:**
- Modify: `apps/api/src/middleware/tenantResolution.ts:23-41` (tenantId resolution) and the two
  `c.set('requestContext', ...)` calls at lines 53 and 85 (merge instead of overwrite).
- Test: `apps/api/src/middleware/tenantResolution.test.ts`

**Interfaces:**
- Consumes: `apiKeyContext` from `apps/api/src/middleware/apiKeyAuth.ts` — an object of shape
  `{ keyId: string, tenantId: string, type: string, permissions: string[] }`, set via
  `c.set('apiKeyContext', ...)` before `tenantResolutionMiddleware` runs (confirmed by the middleware
  order in `apps/api/src/app.ts:139,142`: `apiKeyAuthMiddleware` before `tenantResolutionMiddleware`).
  `apiKeys.tenantId` is a `NOT NULL` column (`packages/foundation/database/schema/access.ts:11`), so
  whenever `apiKeyContext` exists, `apiKeyContext.tenantId` is always a real value — never falls through
  to the onboarding branch.
- Produces: after this task, `requestContext.tenant` is populated for agent-authenticated requests (same
  shape as the JWT path: `{ id, slug, status }`), AND `requestContext.permissions` (set earlier by
  `apiKeyAuthMiddleware`) survives instead of being wiped by this middleware's overwrite.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/middleware/tenantResolution.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { tenantResolutionMiddleware } from './tenantResolution'

const mockTenantRow = { id: 'tenant-1', slug: 'acme', status: 'active' as const }

vi.mock('@serverless-saas/cache', () => ({
  getCacheClient: () => ({
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
  }),
}))

vi.mock('@serverless-saas/database', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([mockTenantRow]),
        }),
      }),
    }),
  },
}))

describe('tenantResolutionMiddleware', () => {
  beforeEach(() => vi.clearAllMocks())

  it('resolves tenantId from apiKeyContext when no jwtPayload is present (agent request)', async () => {
    const app = new Hono()
    app.use('*', async (c, next) => {
      // Simulate apiKeyAuthMiddleware having already run: apiKeyContext set, jwtPayload absent,
      // requestContext.permissions already narrowed by Task 2's fix.
      c.set('apiKeyContext' as never, { keyId: 'key-1', tenantId: 'tenant-1', type: 'agent', permissions: ['agent_tasks:create'] } as never)
      c.set('requestContext' as never, { permissions: ['agent_tasks:create'] } as never)
      await next()
    })
    app.use('*', tenantResolutionMiddleware)
    app.get('/test', (c) => {
      const requestContext = c.get('requestContext' as never) as any
      return c.json({ tenant: requestContext?.tenant ?? null, permissions: requestContext?.permissions ?? null })
    })

    const res = await app.request('/test')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.tenant).toEqual({ id: 'tenant-1', slug: 'acme', status: 'active' })
    // The permissions Task 2 set must survive — this is the bug this task fixes
    expect(body.permissions).toEqual(['agent_tasks:create'])
  })

  it('still resolves tenantId from jwtPayload when present (human/JWT request, unchanged behavior)', async () => {
    const app = new Hono()
    app.use('*', async (c, next) => {
      c.set('jwtPayload' as never, { 'custom:tenantId': 'tenant-1' } as never)
      await next()
    })
    app.use('*', tenantResolutionMiddleware)
    app.get('/test', (c) => {
      const requestContext = c.get('requestContext' as never) as any
      return c.json({ tenant: requestContext?.tenant ?? null })
    })

    const res = await app.request('/test')
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.tenant).toEqual({ id: 'tenant-1', slug: 'acme', status: 'active' })
  })

  it('still returns 403 onboarding-required when neither jwtPayload nor apiKeyContext carry a tenantId', async () => {
    const app = new Hono()
    app.use('*', tenantResolutionMiddleware)
    app.get('/api/v1/some-protected-route', (c) => c.json({ ok: true }))

    const res = await app.request('/api/v1/some-protected-route')
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.code).toBe('ONBOARDING_REQUIRED')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm vitest run src/middleware/tenantResolution.test.ts`
Expected: FAIL — the first test fails because `tenantId` is currently derived only from `jwtPayload`, so
the agent-context request falls into the `!tenantId` branch and gets a 403 instead of 200 with the
resolved tenant.

- [ ] **Step 3: Write minimal implementation**

In `apps/api/src/middleware/tenantResolution.ts`, replace lines 23-32:

```ts
export const tenantResolutionMiddleware = createMiddleware<AppEnv>(async (c, next) => {
    // tenantId is stamped into the JWT by the pre-token Lambda at login (ADR-008)
    // API Gateway validates the JWT signature upstream — we just read the claims
    const jwtPayload = c.get('jwtPayload');

    // Agent-authenticated requests never carry a JWT — apiKeyAuthMiddleware (which runs
    // before this middleware) already resolved and validated tenantId for them, via a
    // NOT NULL column, so apiKeyContext.tenantId is always a real value when present.
    const apiKeyContext = c.get('apiKeyContext' as never) as { tenantId?: string } | undefined;
    const tenantId = jwtPayload?.['custom:tenantId'] ?? apiKeyContext?.tenantId;

    // Empty tenantId = new user who hasn't created a workspace yet
    // Set onboarding flag and only allow specific routes through
    if (!tenantId) {
        c.set('requestContext', { needsOnboarding: true } as any);
```

Then replace the two `c.set('requestContext', { tenant: ... } as any);` calls (originally lines 53 and 85)
so they merge with whatever `requestContext` already holds instead of overwriting it — this is what
preserves `permissions` set earlier by `apiKeyAuthMiddleware`:

```ts
        const existingRequestContext = (c.get('requestContext') as any) ?? {};
        c.set('requestContext', { ...existingRequestContext, tenant: parsed } as any);
```

(cache-hit branch), and:

```ts
    const existingRequestContext = (c.get('requestContext') as any) ?? {};
    c.set('requestContext', { ...existingRequestContext, tenant: tenantContext } as any);
```

(DB-lookup-success branch, replacing the final `c.set('requestContext', { tenant: tenantContext } as any);`
line). Leave the tenant-not-found (404) and tenant-suspended (403) branches unchanged — they return before
reaching either `c.set` call.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && pnpm vitest run src/middleware/tenantResolution.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full apps/api test suite to check for regressions**

Run: `cd apps/api && pnpm vitest run`
Expected: PASS — includes Task 2's `apiKeyAuth.test.ts` (unaffected, it doesn't exercise
`tenantResolutionMiddleware`) and this task's new test.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/middleware/tenantResolution.ts apps/api/src/middleware/tenantResolution.test.ts
git commit -m "fix(api): resolve tenant from apiKeyContext so agent requests aren't 403'd pre-route"
```

---

### Task 4: Backfill migration for existing agent-type keys

**Files:**
- Create: `packages/foundation/database/migrations/0048_backfill_agent_key_permissions.sql`
- Modify: `packages/foundation/database/migrations/meta/_journal.json`

**Interfaces:**
- Consumes: nothing from prior tasks — this is a standalone SQL migration. Must be applied to the database *before* or *simultaneously with* deploying Task 2's code (an active agent key with `permissions = '{}'` would otherwise be intersected down to nothing and start getting 403s).

- [ ] **Step 1: Write the migration SQL**

Create `packages/foundation/database/migrations/0048_backfill_agent_key_permissions.sql`:

```sql
-- Freeze current effective access for every agent-type key that predates
-- permission-scope enforcement (empty permissions array = previously granted
-- the agent's full role, per the bug fixed in apiKeyAuthMiddleware).
-- Keys with a non-empty permissions array already reflect a real choice and
-- are left untouched.
UPDATE "api_keys" AS ak
SET "permissions" = role_perms.permission_strings
FROM (
  SELECT
    m."agent_id" AS agent_id,
    m."tenant_id" AS tenant_id,
    array_agg(DISTINCT (p."resource" || ':' || p."action")) AS permission_strings
  FROM "memberships" m
  INNER JOIN "role_permissions" rp ON rp."role_id" = m."role_id"
  INNER JOIN "permissions" p ON p."id" = rp."permission_id"
  WHERE m."status" = 'active'
  GROUP BY m."agent_id", m."tenant_id"
) AS role_perms
WHERE ak."type" = 'agent'
  AND ak."status" = 'active'
  AND ak."permissions" = '{}'
  AND ak."agent_id" = role_perms.agent_id
  AND ak."tenant_id" = role_perms.tenant_id;
--> statement-breakpoint
```

- [ ] **Step 2: Register the migration in the journal**

Open `packages/foundation/database/migrations/meta/_journal.json` and add a new entry after the `0047_handover_packs` entry (matching the existing compact style used for recent entries):

```json
    { "idx": 47, "version": "7", "when": 1780243620000, "tag": "0048_backfill_agent_key_permissions", "breakpoints": true }
```

Make sure this new object is added inside the `entries` array's closing `]`, with a comma added after the preceding `0047_handover_packs` entry.

- [ ] **Step 3: Verify the migration applies cleanly against a local/dev database**

Run: `cd packages/foundation/database && pnpm exec drizzle-kit migrate`
Expected: migration `0048_backfill_agent_key_permissions` applies with no errors. If no local database is configured, at minimum run `pnpm exec drizzle-kit check` to confirm the journal entry is well-formed and doesn't conflict with the existing migration chain.

- [ ] **Step 4: Manually verify the backfill logic against a sample row**

Run against the dev database (adjust the `WHERE` to a known test tenant/agent if needed):

```sql
SELECT id, agent_id, tenant_id, permissions
FROM api_keys
WHERE type = 'agent' AND status = 'active'
ORDER BY created_at DESC
LIMIT 5;
```

Expected: any row that previously had `permissions = '{}'` now shows the full list of `"resource:action"` strings matching that agent's current role — confirm at least one row's list against the same role's permissions queried via `role_permissions`/`permissions` join, to be sure the intersection in Task 2 won't unexpectedly strip anything for pre-existing keys.

- [ ] **Step 5: Commit**

```bash
git add packages/foundation/database/migrations/0048_backfill_agent_key_permissions.sql packages/foundation/database/migrations/meta/_journal.json
git commit -m "fix(db): backfill agent api key permissions before scope enforcement"
```

---

### Task 5: Fix agent lookup to use `agents.apiKeyId` (the link that's actually populated)

**Why this task exists (discovered during the final whole-branch review, not in the original spec):**
`apiKeys.agentId` (`packages/foundation/database/schema/access.ts:10`) is never written by any insert
in this repo. `POST /api-keys` (`apps/api/src/routes/api-keys.ts:171-178`) creates every agent-type key
without setting `agentId`. `apiKeyAuthMiddleware:52-54` hard-401s any key where `agentId` is null —
meaning **every agent-type API key fails authentication today**, independent of anything else in this
plan. The link that IS populated runs the other direction: `agents.apiKeyId`
(`products/agent-platform/packages/schema/agents.ts:27`, `NOT NULL`) is set by every agent-creation path
(`products/agent-platform/packages/api/routes/agents.crud.ts`, `apps/api/src/routes/onboarding.ts`).
This also makes Task 4's backfill migration a guaranteed `UPDATE 0` (it joins on `ak.agent_id`, always
NULL), and it means Task 3's tenant-resolution fix, while itself correct, is unreachable in production —
requests die at this earlier 401, one middleware before Task 3's fix ever runs.

**Files:**
- Modify: `apps/api/src/middleware/apiKeyAuth.ts:52-63` (agent lookup)
- Modify: `packages/foundation/database/migrations/0048_backfill_agent_key_permissions.sql` (rewrite the
  join to match)
- Create: `apps/api/src/middleware/agentAuthChain.test.ts` — a full-chain integration test mounting the
  real middleware order (`authInjection` → `userUpsert` → `apiKeyAuth` → `tenantResolution` →
  `permissions`) for an agent-authenticated request. This is the test whose absence let the previous
  three tasks each look correct in isolation while the chain as a whole was still broken — see the final
  review's Important finding #2.

**Interfaces:**
- Consumes: `agents` table from `@serverless-saas/agent-schema/agents` (already imported in
  `apiKeyAuth.ts:6`), specifically `agents.apiKeyId` and `agents.status`.
- Produces: after this task, `apiKeyAuthMiddleware` finds the agent for a given key via
  `agents.apiKeyId = apiKey.id` instead of `agents.id = apiKey.agentId`. Nothing downstream of the
  lookup changes — `agent.id`, `agent.status` are used identically afterward.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/middleware/agentAuthChain.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { authInjectionMiddleware } from './authInjection'
import { userUpsertMiddleware } from './userUpsert'
import { apiKeyAuthMiddleware } from './apiKeyAuth'
import { tenantResolutionMiddleware } from './tenantResolution'
import { permissionsMiddleware } from './permissions'

// The linkage this test exists to prove: an agent row found via agents.apiKeyId
// (NOT apiKeys.agentId, which no insert in this repo ever populates).
const mockApiKeyRow = {
  id: 'key-1',
  tenantId: 'tenant-1',
  keyHash: 'hash',
  type: 'agent' as const,
  permissions: ['agent_tasks:create'],
  status: 'active' as const,
  expiresAt: null,
}
const mockAgentRow = { id: 'agent-1', apiKeyId: 'key-1', status: 'active' as const }
const mockMembershipRow = { agentId: 'agent-1', tenantId: 'tenant-1', status: 'active' as const, roleId: 'role-1' }
const mockRolePermissionRows = [
  { resource: 'agent_tasks', action: 'create' },
  { resource: 'agent_tasks', action: 'delete' },
]
const mockTenantRow = { id: 'tenant-1', slug: 'acme', status: 'active' as const }

vi.mock('@serverless-saas/cache', () => ({
  getCacheClient: () => ({ get: () => Promise.resolve(null), set: () => Promise.resolve() }),
}))

vi.mock('@serverless-saas/database', () => {
  let call = 0
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => {
      call += 1
      if (call === 1) return Promise.resolve([mockApiKeyRow])   // apiKeys lookup by hash
      if (call === 2) return Promise.resolve([mockAgentRow])    // agents lookup by apiKeyId
      if (call === 3) return Promise.resolve([mockMembershipRow]) // memberships lookup
      if (call === 4) return Promise.resolve([mockTenantRow])   // tenants lookup (tenantResolution)
      return Promise.resolve([])
    },
    then: (resolve: any) => resolve(mockRolePermissionRows), // permission join, no .limit()
  }
  return {
    db: {
      select: () => chain,
      update: () => ({ set: () => ({ where: () => ({ execute: () => Promise.resolve() }) }) }),
    },
  }
})

describe('agent request through the real middleware chain', () => {
  beforeEach(() => vi.clearAllMocks())

  it('resolves tenant and narrowed permissions for a valid agent API key end-to-end', async () => {
    const app = new Hono()
    app.use('*', authInjectionMiddleware)
    app.use('*', userUpsertMiddleware)
    app.use('*', apiKeyAuthMiddleware)
    app.use('*', tenantResolutionMiddleware)
    app.use('*', permissionsMiddleware)
    app.get('/test', (c) => {
      const requestContext = c.get('requestContext' as never) as any
      return c.json({
        tenant: requestContext?.tenant ?? null,
        permissions: requestContext?.permissions ?? null,
      })
    })

    const res = await app.request('/test', { headers: { Authorization: 'Bearer ak_testkey' } })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.tenant).toEqual({ id: 'tenant-1', slug: 'acme', status: 'active' })
    expect(body.permissions).toEqual(['agent_tasks:create'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm vitest run src/middleware/agentAuthChain.test.ts`
Expected: FAIL — the agent lookup in `apiKeyAuthMiddleware` currently queries `agents.id = apiKey.agentId`, and `mockApiKeyRow` has no `agentId` field (matching production reality), so the lookup returns no rows and the request 401s with "API key is not linked to an agent" instead of reaching 200.

- [ ] **Step 3: Write minimal implementation**

In `apps/api/src/middleware/apiKeyAuth.ts`, replace lines 52-63:

```ts
    // Look up the agent this key belongs to via agents.apiKeyId — the link that's
    // actually populated by every agent-creation path. apiKeys.agentId is never
    // written anywhere in this repo and must not be used for this lookup.
    const [agent] = await db.select().from(agents).where(eq(agents.apiKeyId, apiKey.id)).limit(1);

    if (!agent) {
        console.log('401 reason: api key not linked to agent', { path: c.req.path, keyId: apiKey.id, tenantId: apiKey.tenantId });
        return c.json({ error: 'API key is not linked to an agent' }, 401);
    }

    if (agent.status !== 'active') {
        console.log('401 reason: agent not active', { path: c.req.path, agentId: agent.id, agentStatus: agent.status });
        return c.json({ error: 'Agent is not active' }, 401);
    }
```

- [ ] **Step 4: Fix the backfill migration's join to match**

Replace the full contents of `packages/foundation/database/migrations/0048_backfill_agent_key_permissions.sql`:

```sql
-- Freeze current effective access for every agent-type key that predates
-- permission-scope enforcement (empty permissions array = previously granted
-- the agent's full role, per the bug fixed in apiKeyAuthMiddleware).
-- Keys with a non-empty permissions array already reflect a real choice and
-- are left untouched.
--
-- Joins through agents.api_key_id (NOT api_keys.agent_id, which no insert in
-- this repo ever populates — see apiKeyAuth.ts's agent lookup for the same fix).
--
-- A key whose agent has no active membership, or whose role currently has zero
-- permissions, is intentionally left at '{}' — there is no current effective
-- access to freeze for it.
UPDATE "api_keys" AS ak
SET "permissions" = role_perms.permission_strings
FROM (
  SELECT
    a."api_key_id" AS api_key_id,
    array_agg(DISTINCT (p."resource" || ':' || p."action")) AS permission_strings
  FROM "agents" a
  INNER JOIN "memberships" m ON m."agent_id" = a."id" AND m."tenant_id" = a."tenant_id"
  INNER JOIN "role_permissions" rp ON rp."role_id" = m."role_id"
  INNER JOIN "permissions" p ON p."id" = rp."permission_id"
  WHERE m."status" = 'active'
  GROUP BY a."api_key_id"
) AS role_perms
WHERE ak."type" = 'agent'
  AND ak."status" = 'active'
  AND ak."permissions" = '{}'
  AND ak."id" = role_perms.api_key_id;
```

(No trailing `--> statement-breakpoint` — matches the convention in `0046_task_revisions.sql` and
`0047_handover_packs.sql`, neither of which ends with one, per the final review's Minor finding #6.)

This is a content replacement of an already-created, already-committed file — no journal change needed
(the migration keeps its number and filename; only its SQL body changes because it hadn't yet been
deployed anywhere).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && pnpm vitest run src/middleware/agentAuthChain.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full apps/api test suite to check for regressions**

Run: `cd apps/api && pnpm vitest run`
Expected: PASS — includes Tasks 2's and 3's existing tests plus this task's new chain test.

- [ ] **Step 7: Verify the migration syntax**

Run: `cd packages/foundation/database && pnpm exec drizzle-kit check`
Expected: no errors (mirrors Task 4's Step 3 verification method — no live database is expected to be
configured in this environment).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/middleware/apiKeyAuth.ts apps/api/src/middleware/agentAuthChain.test.ts packages/foundation/database/migrations/0048_backfill_agent_key_permissions.sql
git commit -m "fix(api): resolve agent via agents.apiKeyId, the link that is actually populated"
```

---

## Deployment Note (not a task — sequencing reminder for whoever deploys this)

Per the spec: "The migration and the middleware change ship together: enforcement without the backfill breaks live integrations; the backfill without enforcement fixes nothing." Apply Task 4's migration (`sam deploy` triggers DB migration per this repo's deployment flow, or run `drizzle-kit migrate` directly against the target environment) in the same release as Task 2's code change — not as a follow-up. Task 3 (tenant resolution fix) must also ship in the same release as Task 2 — without it, Task 2's enforcement never reaches a route handler on a real request. Task 5 (agent lookup fix) must ship in that same release too — without it, no agent-type API key authenticates at all, so nothing upstream of it (Tasks 2–4) ever executes on real traffic. Before deploying, confirm against the target environment that `agents.api_key_id` is actually populated for the keys you expect to keep working (`SELECT count(*) FROM agents WHERE api_key_id IS NOT NULL;`) — this plan does not include a migration to populate it retroactively, because every observed agent-creation code path already sets it at creation time.

**Known limitation — onboarding-seeded agents lack memberships.** The six agents created by
`apps/api/src/routes/onboarding.ts` during workspace setup (Research Engineer, Product Manager, PRD,
Roadmap, Task, Architect) never get a `memberships` row — only the human workspace owner does. This
means `apiKeyAuthMiddleware`'s membership check (`apiKeyAuth.ts:67-77`) will 403 these agents even after
this branch ships, for a reason unrelated to permission scoping. This predates this branch and is out of
scope for it; it requires a fix to the onboarding flow itself (inserting an agent membership per seeded
agent) as separate follow-up work.

**Known limitation — agent traffic shares a per-IP rate-limit bucket.** The rate limiter in
`apps/api/src/app.ts` keys on the JWT's tenant claim, which agent-authenticated requests never have, so
all agent traffic across all tenants currently falls into one shared 20 req/min per-IP bucket (agents
typically call from the same GCP VM egress IP). This predates this branch — it becomes an operationally
relevant issue only once agent traffic actually starts flowing, which this branch is what enables. Track
as follow-up: prefer `apiKeyContext?.tenantId` for the rate-limit key when present, which requires either
reordering the limiter after `apiKeyAuthMiddleware` or a cheap pre-resolve of the API key before rate
limiting.

---

## Self-Review Notes

- **Spec coverage:** Part 1 (intersect at request time) → Tasks 1–2, made reachable in a real request by Task 3 and Task 5 (two gaps discovered during review — Task 3 during Task 2's task-level review, Task 5 during the final whole-branch review — neither originally in the spec, both required for the spec's own stated behavior to manifest end-to-end on real traffic). Part 2 (backfill, ship together) → Task 4 + Deployment Note, with its join corrected by Task 5 once the actual agent↔key link was identified. Part 3 (agent-type only) → Global Constraints + Task 4's `WHERE type = 'agent'`. Testing section's 5 cases → covered by Task 1's unit tests (intersection logic) and Task 2's test (context wiring); the two "integration" cases in the spec (backfilled key still passes, newly-scoped key gets 403) are exercised end-to-end by Task 5's full-chain test, which is what actually proves the wiring — Task 2's and Task 3's tests alone could not, since neither composed the real middleware chain (this is precisely the gap the final review's Important finding #2 identified).
- **Placeholder scan:** none found — all steps have runnable code.
- **Type consistency:** `intersectPermissions(keyPermissions: string[], rolePermissions: string[]): string[]` is defined identically in Task 1 and consumed identically in Task 2. Confirmed `apiKeys.permissions` (schema) and `resolvedPermissions`/`rolePermissions` (middleware) are both `string[]` in `"resource:action"` format — no shape mismatch.
