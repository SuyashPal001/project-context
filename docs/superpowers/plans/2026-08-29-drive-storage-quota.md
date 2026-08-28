# Drive Storage Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound per-tenant storage with a silent abuse ceiling, and make stored bytes agree with billed bytes by actually deleting objects.

**Architecture:** The quota is checked at presign, before any URL is signed, and the declared size is bound into the S3 signature so a client cannot upload more than it declared. Soft deletion continues to keep the row for audit but now enqueues a `storage.purge` job on the existing SQS worker to remove the object. Abandoned `pending` uploads are swept opportunistically per tenant on each presign.

**Tech Stack:** Hono (Lambda), Drizzle ORM on Supabase Postgres, AWS S3 via `@aws-sdk/client-s3`, SQS worker Lambda, Next.js App Router + React Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-drive-storage-quota-design.md`

## Global Constraints

- One GB is exactly `1024 ** 3` bytes. Defined once, imported everywhere.
- Per-file cap: 500 MB (`500 * 1024 * 1024` = 524288000 bytes).
- Plan quotas: free 20 GB, starter 200 GB, business 1000 GB, enterprise `unlimited: true`.
- Enforcement happens at presign, never only at confirm.
- The usage counter must run for `unlimited` tenants too — enterprise is billed by consumption and unmetered history cannot be reconstructed.
- `size` is **optional** on the presign endpoint until Task 11. Making it required before every caller sends it breaks agent file generation across a deploy boundary.
- Storage is foundation, not product. Nothing here goes in `products/*`.
- Entitlement maps are keyed by **featureId (UUID)**, not feature key. Look up `features` by key first. Do not use `checkUsage`/`checkLimit` from `@serverless-saas/entitlements` — they read a shape the middleware never produces.
- A missing entitlement map is a wiring error: throw, never default.
- Storage limits are never advertised. The only place a number appears is an error payload and the ≥80% meter.

---

### Task 1: Quota arithmetic (pure functions)

All the decision logic, with no database and no Hono, so it is testable in isolation. Mirrors the existing `apps/api/src/routes/tenants.limit.ts` convention.

**Files:**
- Create: `apps/api/src/routes/files.quota.ts`
- Test: `apps/api/src/routes/files.quota.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `GB_BYTES: number`
  - `MAX_FILE_BYTES: number`
  - `interface StorageLimit { unlimited: boolean; limitBytes: number }`
  - `resolveStorageLimit(entitlements: Record<string, { valueLimit?: number | null; unlimited?: boolean | null }> | undefined, featureId: string): StorageLimit`
  - `type UploadDecision = { allowed: true } | { allowed: false; code: 'file_too_large'; maxBytes: number; size: number } | { allowed: false; code: 'storage_quota_exceeded'; usedBytes: number; limitBytes: number; size: number }`
  - `decideUpload(args: { size: number; usedBytes: number; limit: StorageLimit }): UploadDecision`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { GB_BYTES, MAX_FILE_BYTES, resolveStorageLimit, decideUpload } from './files.quota';

const FEATURE = 'feat-storage-gb';

describe('GB_BYTES', () => {
  // Guards the GB/GiB convention. If this flips to 1e9 the meter and the
  // enforcement path disagree about what a gigabyte is.
  it('is binary, not decimal', () => {
    expect(GB_BYTES).toBe(1073741824);
  });
});

describe('resolveStorageLimit', () => {
  it('refuses to guess when the entitlement map is missing entirely', () => {
    expect(() => resolveStorageLimit(undefined, FEATURE)).toThrow(/entitlements/i);
  });

  it('converts the plan limit from GB to bytes', () => {
    const result = resolveStorageLimit({ [FEATURE]: { valueLimit: 20 } }, FEATURE);
    expect(result).toEqual({ unlimited: false, limitBytes: 20 * 1073741824 });
  });

  it('reports unlimited without inventing a byte limit', () => {
    const result = resolveStorageLimit({ [FEATURE]: { unlimited: true } }, FEATURE);
    expect(result).toEqual({ unlimited: true, limitBytes: 0 });
  });

  it('treats a present map that lacks the feature as a real zero grant', () => {
    // Distinct from the missing-map case above: this plan genuinely grants no
    // storage, which is an answer, not a wiring error.
    const result = resolveStorageLimit({}, FEATURE);
    expect(result).toEqual({ unlimited: false, limitBytes: 0 });
  });
});

describe('decideUpload', () => {
  const limited = { unlimited: false, limitBytes: 20 * 1073741824 };

  it('allows a file that fits within remaining headroom', () => {
    expect(decideUpload({ size: 1000, usedBytes: 0, limit: limited })).toEqual({ allowed: true });
  });

  it('allows a file exactly at the per-file cap', () => {
    expect(decideUpload({ size: MAX_FILE_BYTES, usedBytes: 0, limit: limited })).toEqual({ allowed: true });
  });

  it('rejects one byte over the per-file cap', () => {
    expect(decideUpload({ size: MAX_FILE_BYTES + 1, usedBytes: 0, limit: limited })).toEqual({
      allowed: false, code: 'file_too_large', maxBytes: MAX_FILE_BYTES, size: MAX_FILE_BYTES + 1,
    });
  });

  it('allows a file that exactly fills the remaining quota', () => {
    const usedBytes = limited.limitBytes - 500;
    expect(decideUpload({ size: 500, usedBytes, limit: limited })).toEqual({ allowed: true });
  });

  it('rejects a file one byte beyond the remaining quota', () => {
    const usedBytes = limited.limitBytes - 500;
    expect(decideUpload({ size: 501, usedBytes, limit: limited })).toEqual({
      allowed: false, code: 'storage_quota_exceeded', usedBytes, limitBytes: limited.limitBytes, size: 501,
    });
  });

  it('checks the per-file cap before the quota', () => {
    // An oversized file on an already-full tenant should say the useful thing.
    const oversized = MAX_FILE_BYTES + 1;
    const result = decideUpload({ size: oversized, usedBytes: limited.limitBytes, limit: limited });
    expect(result).toMatchObject({ code: 'file_too_large' });
  });

  it('skips both gates when unlimited', () => {
    const unlimited = { unlimited: true, limitBytes: 0 };
    expect(decideUpload({ size: MAX_FILE_BYTES * 100, usedBytes: 1e15, limit: unlimited })).toEqual({ allowed: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm exec vitest run src/routes/files.quota.test.ts`
Expected: FAIL — cannot resolve `./files.quota`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * Storage quota arithmetic, kept free of Hono and Drizzle so the decisions can
 * be tested without a database.
 *
 * Limits are an abuse ceiling, not a monetization lever: they are unadvertised
 * and set generously enough that ordinary use never reaches them. The numbers
 * only ever surface in a rejection payload.
 */

/** Binary gigabyte. Entitlements store GB; every byte comparison uses this. */
export const GB_BYTES = 1024 ** 3;

/** Per-file ceiling. Fits phone video and long audio, so real users never hit it. */
export const MAX_FILE_BYTES = 500 * 1024 * 1024;

export interface StorageLimit {
  unlimited: boolean;
  /** Meaningless when `unlimited` — read the flag first. */
  limitBytes: number;
}

interface ResolvedEntitlement {
  valueLimit?: number | null;
  unlimited?: boolean | null;
}

/**
 * Entitlement maps from entitlementsMiddleware are keyed by featureId (UUID),
 * not by feature key, and carry only {enabled, valueLimit, unlimited}. Callers
 * must look the UUID up in `features` first.
 *
 * An absent map means the middleware did not run for this request — a wiring
 * error, not a free-tier user. The same reasoning is documented at length in
 * tenants.limit.ts, where defaulting instead of throwing hid a revenue bug.
 */
export function resolveStorageLimit(
  entitlements: Record<string, ResolvedEntitlement> | undefined,
  featureId: string,
): StorageLimit {
  if (!entitlements) {
    throw new Error(
      'entitlements missing from request context — the storage limit cannot be resolved. ' +
        'This route must be registered after entitlementsMiddleware in app.ts.',
    );
  }

  const entitlement = entitlements[featureId];
  if (entitlement?.unlimited) return { unlimited: true, limitBytes: 0 };

  return { unlimited: false, limitBytes: (entitlement?.valueLimit ?? 0) * GB_BYTES };
}

export type UploadDecision =
  | { allowed: true }
  | { allowed: false; code: 'file_too_large'; maxBytes: number; size: number }
  | { allowed: false; code: 'storage_quota_exceeded'; usedBytes: number; limitBytes: number; size: number };

export function decideUpload(args: {
  size: number;
  usedBytes: number;
  limit: StorageLimit;
}): UploadDecision {
  const { size, usedBytes, limit } = args;

  if (limit.unlimited) return { allowed: true };

  // Per-file first: an oversized file on a full tenant should be told the
  // actionable thing, which is that the file itself is too big.
  if (size > MAX_FILE_BYTES) {
    return { allowed: false, code: 'file_too_large', maxBytes: MAX_FILE_BYTES, size };
  }

  if (usedBytes + size > limit.limitBytes) {
    return { allowed: false, code: 'storage_quota_exceeded', usedBytes, limitBytes: limit.limitBytes, size };
  }

  return { allowed: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && pnpm exec vitest run src/routes/files.quota.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/files.quota.ts apps/api/src/routes/files.quota.test.ts
git commit -m "feat(storage): quota arithmetic for per-file cap and tenant headroom"
```

---

### Task 2: Register the `storage_gb` usage counter

**Files:**
- Create: `apps/api/src/usage-counters.ts`
- Create: `apps/api/src/usage-counters.test.ts`
- Modify: `apps/api/src/app.ts` — call `registerFoundationCounters()` once at module scope, next to the other foundation wiring.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `registerFoundationCounters(): void`
  - `sumTenantStorageBytes(tenantId: string): Promise<number>` — exported for reuse by Task 6.

This is the first counter registered by foundation code; `agents` is registered by the agent platform in `products/agent-platform/packages/api/index.ts:50-58`. Follow that file's `countersRegistered` guard so repeated imports do not re-register.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const selectMock = vi.fn();
vi.mock('@serverless-saas/database', () => ({ db: { select: (...a: unknown[]) => selectMock(...a) } }));

const registerUsageCounter = vi.fn();
vi.mock('@serverless-saas/entitlements', () => ({ registerUsageCounter }));

describe('registerFoundationCounters', () => {
  beforeEach(() => {
    vi.resetModules();
    registerUsageCounter.mockClear();
  });

  it('registers storage_gb exactly once even if called twice', async () => {
    const { registerFoundationCounters } = await import('./usage-counters');
    registerFoundationCounters();
    registerFoundationCounters();
    expect(registerUsageCounter).toHaveBeenCalledTimes(1);
    expect(registerUsageCounter).toHaveBeenCalledWith('storage_gb', expect.any(Function));
  });
});

describe('sumTenantStorageBytes', () => {
  it('parses the bigint sum, which postgres returns as a string', async () => {
    // sum() over an integer column returns bigint; the driver hands it back as
    // a string. Returning it unparsed makes every comparison a string compare.
    selectMock.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([{ total: '21474836480' }]) }),
    });
    const { sumTenantStorageBytes } = await import('./usage-counters');
    await expect(sumTenantStorageBytes('tenant-1')).resolves.toBe(21474836480);
  });

  it('returns 0 for a tenant with no files', async () => {
    selectMock.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([{ total: '0' }]) }),
    });
    const { sumTenantStorageBytes } = await import('./usage-counters');
    await expect(sumTenantStorageBytes('tenant-1')).resolves.toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm exec vitest run src/usage-counters.test.ts`
Expected: FAIL — cannot resolve `./usage-counters`.

- [ ] **Step 3: Write minimal implementation**

```typescript
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { files } from '@serverless-saas/database/schema/storage';
import { registerUsageCounter } from '@serverless-saas/entitlements';

/**
 * Bytes a tenant currently occupies.
 *
 * Only `uploaded` rows count. `pending` rows have no size yet, and `deleted`
 * and `expired` rows are already queued for purge from S3 — counting either
 * would charge a tenant for bytes they cannot free.
 *
 * sum() over an integer column is bigint, which postgres.js returns as a
 * string. Parse it here so no caller has to remember.
 */
export async function sumTenantStorageBytes(tenantId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${files.size}), 0)` })
    .from(files)
    .where(and(eq(files.tenantId, tenantId), eq(files.status, 'uploaded')));

  return Number(row?.total ?? 0);
}

let countersRegistered = false;

/**
 * Foundation-owned usage counters. Mirrors registerCounters() in the agent
 * platform's api package, including the idempotence guard.
 *
 * storage_gb is registered for every tenant, including those on unlimited
 * plans: enterprise storage is billed by consumption, and a tenant that is
 * never metered cannot later be billed for history that was never recorded.
 */
export function registerFoundationCounters(): void {
  if (countersRegistered) return;
  countersRegistered = true;

  registerUsageCounter('storage_gb', sumTenantStorageBytes);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && pnpm exec vitest run src/usage-counters.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire it into the app**

In `apps/api/src/app.ts`, add the import and invoke it once at module scope (not inside a request handler):

```typescript
import { registerFoundationCounters } from './usage-counters';

registerFoundationCounters();
```

- [ ] **Step 6: Verify the app still type-checks**

Run: `cd apps/api && pnpm type-check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/usage-counters.ts apps/api/src/usage-counters.test.ts apps/api/src/app.ts
git commit -m "feat(storage): register storage_gb usage counter"
```

---

### Task 3: Bind the declared size into the S3 signature

Threads an optional `size` from the presign request down to `PutObjectCommand`. With `ContentLength` signed, S3 rejects a body of any other length, so a client that under-declares to pass the quota gate cannot then upload more.

**Files:**
- Modify: `packages/foundation/storage/src/types.ts:2` — `getUploadUrl` gains an optional size.
- Modify: `packages/foundation/storage/src/providers/s3.ts:19-27`
- Modify: `packages/foundation/storage/src/service.ts:74-105`
- Create: `packages/foundation/storage/src/providers/s3.contentLength.test.ts`
- Create: `packages/foundation/storage/vitest.config.ts` (the package has none)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `StorageProvider.getUploadUrl(key: string, contentType: string, expiresIn?: number, size?: number): Promise<{ url: string }>`
  - `UploadUrlRequest` gains `size?: number`.

- [ ] **Step 1: Add a vitest config for the storage package**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
```

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';

const putObjectCalls: Array<Record<string, unknown>> = [];

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { async send() { return {}; } },
  PutObjectCommand: class { constructor(input: Record<string, unknown>) { putObjectCalls.push(input); } },
  GetObjectCommand: class { constructor(public input: unknown) {} },
  DeleteObjectCommand: class { constructor(public input: unknown) {} },
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async () => 'https://s3.test/signed',
}));

import { S3StorageProvider } from './s3';

describe('S3StorageProvider.getUploadUrl', () => {
  const provider = new S3StorageProvider({ bucket: 'b', region: 'r' } as never);

  it('signs ContentLength when a size is given', async () => {
    putObjectCalls.length = 0;
    await provider.getUploadUrl('k', 'text/plain', 3600, 1234);
    expect(putObjectCalls[0]).toMatchObject({ Key: 'k', ContentType: 'text/plain', ContentLength: 1234 });
  });

  it('omits ContentLength entirely when no size is given', async () => {
    // Sending ContentLength: undefined is not the same as omitting it — the
    // signer would still cover the header and every upload would 403.
    putObjectCalls.length = 0;
    await provider.getUploadUrl('k', 'text/plain');
    expect(putObjectCalls[0]).not.toHaveProperty('ContentLength');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/foundation/storage && pnpm exec vitest run src/providers/s3.contentLength.test.ts`
Expected: FAIL — `ContentLength` is not present on the command input.

- [ ] **Step 4: Implement in the provider**

Replace `getUploadUrl` in `packages/foundation/storage/src/providers/s3.ts`:

```typescript
  async getUploadUrl(key: string, contentType: string, expiresIn = 3600, size?: number): Promise<{ url: string }> {
    // ContentLength is only included when known. Passing it as undefined still
    // makes the signer cover the header, which would 403 every upload.
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ...(size === undefined ? {} : { ContentLength: size }),
    });
    const url = await getSignedUrl(this.client, command, { expiresIn });
    return { url };
  }
```

- [ ] **Step 5: Widen the interface**

In `packages/foundation/storage/src/types.ts`, line 2:

```typescript
  getUploadUrl(key: string, contentType: string, expiresIn?: number, size?: number): Promise<{ url: string }>;
```

- [ ] **Step 6: Thread it through the service**

In `packages/foundation/storage/src/service.ts`, add `size?: number` to `UploadUrlRequest`, destructure it in `getUploadUrl`, and pass it to the provider:

```typescript
    const { url } = await provider.getUploadUrl(s3Key, contentType, 3600, size);
```

- [ ] **Step 7: Run tests and type-check**

Run: `cd packages/foundation/storage && pnpm exec vitest run && pnpm exec tsc --noEmit`
Expected: PASS, 2 tests; no type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/foundation/storage
git commit -m "feat(storage): bind declared upload size into the S3 signature"
```

---

### Task 4: Enforce the quota at presign

**Files:**
- Modify: `apps/api/src/routes/files.ts:45-95` — the `/upload` handler.
- Create: `apps/api/src/routes/files.upload.test.ts`

**Interfaces:**
- Consumes: `decideUpload`, `resolveStorageLimit`, `MAX_FILE_BYTES` (Task 1); `sumTenantStorageBytes` (Task 2); `UploadUrlRequest.size` (Task 3).
- Produces: `/files/upload` accepting optional `size: number`, returning 413 with `{ error, code, ... }` on rejection.

`size` stays optional here. Task 11 makes it required, after every caller sends it.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The gate is only real if it runs before the URL is signed. Checking after
 * would hand out a working upload URL and then refuse — the bytes still land.
 */
describe('files upload route wiring', () => {
  const source = readFileSync(join(__dirname, 'files.ts'), 'utf8');

  it('checks the quota before calling getUploadUrl', () => {
    const decideAt = source.indexOf('decideUpload(');
    const signAt = source.indexOf('storageService.getUploadUrl(');
    expect(decideAt).toBeGreaterThan(-1);
    expect(signAt).toBeGreaterThan(-1);
    expect(decideAt).toBeLessThan(signAt);
  });

  it('passes the declared size to the signer', () => {
    expect(source).toMatch(/getUploadUrl\(\{[\s\S]*size,[\s\S]*\}\)/);
  });

  it('accepts size as optional, so callers can be migrated after this ships', () => {
    expect(source).toMatch(/size:\s*z\.number\(\)\.int\(\)\.positive\(\)\.optional\(\)/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm exec vitest run src/routes/files.upload.test.ts`
Expected: FAIL — `decideUpload(` not found in `files.ts`.

- [ ] **Step 3: Add the size field to the request schema**

In the `zValidator('json', ...)` block of `filesRoutes.post('/upload', ...)`:

```typescript
    size: z.number().int().positive().optional(),
```

- [ ] **Step 4: Implement the gate**

Add these imports at the top of `apps/api/src/routes/files.ts`:

```typescript
import { features } from '@serverless-saas/database/schema/entitlements';
import { decideUpload, resolveStorageLimit } from './files.quota';
import { sumTenantStorageBytes } from '../usage-counters';
```

Then, inside the handler, after the permission check and before `storageService.getUploadUrl`:

```typescript
    // Enforce before signing. A gate after the signature still hands out a
    // working upload URL, and the bytes land regardless of what we return.
    if (size !== undefined) {
      const [feature] = await db.select().from(features).where(eq(features.key, 'storage_gb')).limit(1);
      if (!feature) {
        return c.json({ error: 'Feature configuration missing', code: 'FEATURE_NOT_FOUND' }, 500);
      }

      const limit = resolveStorageLimit(requestContext?.entitlements, feature.id);
      // Skipping the sum for unlimited tenants is safe: decideUpload returns
      // early on the flag and never reads usedBytes. This is not the metering
      // the deferred pay-as-you-go billing needs — that comes from periodic
      // snapshots reading the same counter, not from the upload path.
      const usedBytes = limit.unlimited ? 0 : await sumTenantStorageBytes(tenantId);
      const decision = decideUpload({ size, usedBytes, limit });

      if (!decision.allowed) {
        // The numbers go in the payload, not the UI: this rejection is the only
        // place in the product where a storage limit is ever named.
        return c.json(
          decision.code === 'file_too_large'
            ? { error: 'File is too large', code: decision.code, maxBytes: decision.maxBytes, size: decision.size }
            : {
                error: 'Not enough storage remaining',
                code: decision.code,
                usedBytes: decision.usedBytes,
                limitBytes: decision.limitBytes,
                size: decision.size,
              },
          413,
        );
      }
    }
```

Add `size` to the destructured `c.req.valid('json')` result and to the `storageService.getUploadUrl({ ... })` call.

- [ ] **Step 5: Run tests and type-check**

Run: `cd apps/api && pnpm exec vitest run src/routes/files.upload.test.ts && pnpm type-check`
Expected: PASS, 3 tests; no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/files.ts apps/api/src/routes/files.upload.test.ts
git commit -m "feat(storage): enforce per-file cap and tenant quota at presign"
```

---

### Task 5: Purge S3 objects on delete

**Files:**
- Create: `apps/worker/src/handlers/storagePurge.ts`
- Create: `apps/worker/src/handlers/storagePurge.test.ts`
- Modify: `apps/worker/src/router.ts:20-27` — register `storage.purge`.
- Modify: `packages/foundation/storage/src/service.ts:158-170` — `deleteFile` enqueues the job.
- Create: `packages/foundation/storage/src/s3Key.ts`
- Create: `packages/foundation/storage/src/s3Key.test.ts`

**Interfaces:**
- Consumes: `deleteObject(key)` (already on `S3StorageProvider`).
- Produces:
  - `tenantS3Key(tenantId: string, userSpaceKey: string): string`
  - `handleStoragePurge(body: Record<string, unknown>): Promise<void>` for job `storage.purge` with payload `{ tenantId: string, key: string }`.

The database stores the **user-space** key (`documents/report.pdf`), while S3 holds `tenants/{tenantId}/{userSpaceKey}`. Both upload and purge must derive the full key the same way, so the derivation moves into one shared function rather than being spelled twice.

- [ ] **Step 1: Write the failing key-derivation test**

```typescript
import { describe, it, expect } from 'vitest';
import { tenantS3Key } from './s3Key';

describe('tenantS3Key', () => {
  it('prefixes the user-space key with the tenant namespace', () => {
    expect(tenantS3Key('t-1', 'documents/report.pdf')).toBe('tenants/t-1/documents/report.pdf');
  });

  it('is the single definition used by both upload and purge', () => {
    // Purge deletes real objects. If upload and purge derive keys separately
    // and drift, purge either misses the object or deletes the wrong one.
    expect(tenantS3Key('t-1', 'a.png')).toBe('tenants/t-1/a.png');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/foundation/storage && pnpm exec vitest run src/s3Key.test.ts`
Expected: FAIL — cannot resolve `./s3Key`.

- [ ] **Step 3: Implement and adopt it**

Create `packages/foundation/storage/src/s3Key.ts`:

```typescript
/**
 * The database stores the user-space key ("documents/report.pdf") so the folder
 * browser can work with paths the user recognises. S3 holds it namespaced under
 * the tenant. Both upload and purge derive it here, because a purge that
 * derives its own key can drift into deleting the wrong object.
 */
export function tenantS3Key(tenantId: string, userSpaceKey: string): string {
  return `tenants/${tenantId}/${userSpaceKey}`;
}
```

In `service.ts`, replace the inline template in `getUploadUrl` with `const s3Key = tenantS3Key(tenantId, userSpaceKey);`.

- [ ] **Step 4: Write the failing purge-handler test**

```typescript
import { describe, it, expect, vi } from 'vitest';

const deleteObject = vi.fn();
vi.mock('@serverless-saas/storage', () => ({
  storageService: { deleteObjectForTenant: (...a: unknown[]) => deleteObject(...a) },
}));

import { handleStoragePurge } from './storagePurge';

describe('handleStoragePurge', () => {
  it('deletes the object named in the payload', async () => {
    deleteObject.mockResolvedValue(undefined);
    await handleStoragePurge({ type: 'storage.purge', payload: { tenantId: 't-1', key: 'a.png' } });
    expect(deleteObject).toHaveBeenCalledWith('t-1', 'a.png');
  });

  it('ignores a malformed payload instead of failing the SQS batch', async () => {
    // A throw here fails the whole batch item and retries forever for what is
    // a no-op. The cache handler learned this the hard way.
    deleteObject.mockClear();
    await expect(handleStoragePurge({ type: 'storage.purge' })).resolves.toBeUndefined();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('treats an already-absent object as success', async () => {
    // Purge must be idempotent: SQS redelivers, and the second delete of a key
    // that is already gone is the expected steady state, not an error.
    deleteObject.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));
    await expect(
      handleStoragePurge({ type: 'storage.purge', payload: { tenantId: 't-1', key: 'a.png' } }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `cd apps/worker && pnpm exec vitest run src/handlers/storagePurge.test.ts`
Expected: FAIL — cannot resolve `./storagePurge`.

- [ ] **Step 6: Implement the handler**

```typescript
import { storageService } from '@serverless-saas/storage';

interface PurgePayload {
  tenantId: string;
  key: string;
}

/**
 * Removes an S3 object whose database row has already been soft-deleted or
 * expired. Soft deletion keeps the row for audit and ingestion lineage; this
 * job is what stops the bytes from being billed forever.
 */
export async function handleStoragePurge(body: Record<string, unknown>): Promise<void> {
  const payload = body.payload as PurgePayload | undefined;

  if (!payload?.tenantId || !payload?.key) {
    console.log('Storage purge job had no tenantId/key — nothing to do');
    return;
  }

  try {
    await storageService.deleteObjectForTenant(payload.tenantId, payload.key);
    console.log('Storage object purged', { tenantId: payload.tenantId, key: payload.key });
  } catch (error) {
    // Idempotence: SQS redelivers, and the object being already gone is the
    // expected steady state on a retry.
    if ((error as { name?: string })?.name === 'NoSuchKey') return;
    throw error;
  }
}
```

- [ ] **Step 7: Add `deleteObjectForTenant` to the storage service**

In `packages/foundation/storage/src/service.ts`, alongside `deleteFile`:

```typescript
  /** Removes the S3 object itself. The row is handled separately by the caller. */
  async deleteObjectForTenant(tenantId: string, userSpaceKey: string): Promise<void> {
    const provider = await this.resolveProvider(tenantId);
    await provider.deleteObject(tenantS3Key(tenantId, userSpaceKey));
  }
```

- [ ] **Step 8: Enqueue from `deleteFile`**

Modify `deleteFile` so it still soft-deletes the row, then enqueues the purge. Read the row first — the key is needed for the payload:

```typescript
  async deleteFile(tenantId: string, fileId: string): Promise<void> {
    const [row] = await db
      .update(files)
      .set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
      .returning({ key: files.key });

    // No row means nothing was deleted — do not enqueue a purge for a file that
    // may belong to another tenant.
    if (!row?.key) return;

    // Same env var and same guard the ingest enqueue uses at files.ts:131 — a
    // non-null assertion here would throw inside a delete that already succeeded.
    const queueUrl = process.env.SQS_PROCESSING_QUEUE_URL;
    if (!queueUrl) {
      console.error('SQS_PROCESSING_QUEUE_URL unset — object not purged', { tenantId, key: row.key });
      return;
    }

    await publishToQueue(queueUrl, {
      type: 'storage.purge',
      payload: { tenantId, key: row.key },
    });
  }
```

- [ ] **Step 9: Register the handler**

In `apps/worker/src/router.ts`, alongside the other foundation registrations:

```typescript
import { handleStoragePurge } from './handlers/storagePurge';

registerHandler('storage.purge', handleStoragePurge);
```

- [ ] **Step 10: Run tests and type-check**

Run: `cd apps/worker && pnpm exec vitest run && pnpm exec tsc --noEmit`
Then: `cd packages/foundation/storage && pnpm exec vitest run && pnpm exec tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 11: Commit**

```bash
git add apps/worker/src/handlers/storagePurge.ts apps/worker/src/handlers/storagePurge.test.ts apps/worker/src/router.ts packages/foundation/storage
git commit -m "feat(storage): purge S3 objects on delete instead of only marking rows"
```

---

### Task 6: Usage endpoint

**Files:**
- Modify: `apps/api/src/routes/files.ts` — add `GET /usage`.
- Create: `apps/api/src/routes/files.usage.test.ts`

**Interfaces:**
- Consumes: `resolveStorageLimit` (Task 1), `sumTenantStorageBytes` (Task 2).
- Produces: `GET /api/v1/files/usage` → `{ data: { usedBytes: number; limitBytes: number; percent: number; unlimited: boolean } }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { storagePercent } from './files.quota';

describe('storagePercent', () => {
  it('is 0 when nothing is used', () => {
    expect(storagePercent(0, 100)).toBe(0);
  });

  it('rounds to a whole percent', () => {
    expect(storagePercent(505, 1000)).toBe(51);
  });

  it('is 0 for an unlimited plan, whose limitBytes is meaningless', () => {
    // Dividing by the placeholder 0 would yield Infinity and light up the
    // meter permanently for the one plan that should never see it.
    expect(storagePercent(999, 0)).toBe(0);
  });

  it('clamps above the limit rather than exceeding 100', () => {
    // Reachable: a tenant already over quota when enforcement first ships.
    expect(storagePercent(200, 100)).toBe(100);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && pnpm exec vitest run src/routes/files.usage.test.ts`
Expected: FAIL — `storagePercent` is not exported.

- [ ] **Step 3: Add `storagePercent` to `files.quota.ts`**

```typescript
/**
 * Whole-percent usage for the meter. Returns 0 when there is no limit, because
 * the unlimited case carries a placeholder limitBytes of 0 and dividing by it
 * would pin the meter at Infinity for the one plan that should never show one.
 */
export function storagePercent(usedBytes: number, limitBytes: number): number {
  if (limitBytes <= 0) return 0;
  return Math.min(100, Math.round((usedBytes / limitBytes) * 100));
}
```

- [ ] **Step 4: Add the route**

In `apps/api/src/routes/files.ts`, registered before the `/:id` routes so `usage` is not captured as an id:

```typescript
// Storage usage for the current tenant. Feeds the meter that Drive shows only
// above 80% — storage is otherwise never surfaced.
filesRoutes.get('/usage', async (c) => {
  const requestContext = c.get('requestContext') as any;
  const tenantId = requestContext?.tenant?.id;

  const [feature] = await db.select().from(features).where(eq(features.key, 'storage_gb')).limit(1);
  if (!feature) {
    return c.json({ error: 'Feature configuration missing', code: 'FEATURE_NOT_FOUND' }, 500);
  }

  const limit = resolveStorageLimit(requestContext?.entitlements, feature.id);
  const usedBytes = await sumTenantStorageBytes(tenantId);

  return c.json({
    data: {
      usedBytes,
      limitBytes: limit.limitBytes,
      unlimited: limit.unlimited,
      percent: limit.unlimited ? 0 : storagePercent(usedBytes, limit.limitBytes),
    },
  });
});
```

- [ ] **Step 5: Run tests and type-check**

Run: `cd apps/api && pnpm exec vitest run src/routes/files.usage.test.ts && pnpm type-check`
Expected: PASS, 4 tests; no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/files.ts apps/api/src/routes/files.quota.ts apps/api/src/routes/files.usage.test.ts
git commit -m "feat(storage): expose per-tenant storage usage"
```

---

### Task 7: `expired` status and orphan reclamation

**Files:**
- Modify: `packages/foundation/database/schema/storage.ts:17` — add `expired` to `fileStatusEnum`.
- Create: migration via `drizzle-kit generate`.
- Create: `apps/api/src/routes/files.reclaim.ts`
- Create: `apps/api/src/routes/files.reclaim.test.ts`
- Modify: `apps/api/src/routes/files.ts` — call the sweep at the top of `/upload`.

**Interfaces:**
- Consumes: `tenantS3Key` is not needed here; the purge payload carries the user-space key.
- Produces: `reclaimAbandonedUploads(tenantId: string): Promise<number>` returning how many rows were expired.

An upload that never confirms leaves a `pending` row with `size` null and bytes in S3 that no sum can see. The sweep is opportunistic rather than scheduled: it is tenant-scoped and bounded by that one tenant's abandoned uploads in the last hour, so it needs no EventBridge rule.

- [ ] **Step 1: Add the enum value**

In `packages/foundation/database/schema/storage.ts`:

```typescript
export const fileStatusEnum = pgEnum('file_status', ['pending', 'uploaded', 'deleted', 'expired']);
```

`expired` stays distinct from `deleted` so the two populations remain separable: `deleted` means a user removed a real file, `expired` means an upload never completed.

- [ ] **Step 2: Generate the migration**

Run: `cd packages/foundation/database && pnpm exec drizzle-kit generate`
Expected: a new migration containing `ALTER TYPE "file_status" ADD VALUE 'expired'`.

- [ ] **Step 3: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { PRESIGN_EXPIRY_MS, abandonedBefore } from './files.reclaim';

describe('abandonedBefore', () => {
  it('is one hour behind now, matching the presign expiry', () => {
    // Sweeping anything younger would expire an upload that is still legitimately
    // in flight, and the client would get a 403 from S3 on a URL we just issued.
    const now = new Date('2026-08-29T12:00:00Z');
    expect(abandonedBefore(now)).toEqual(new Date('2026-08-29T11:00:00Z'));
  });

  it('uses the same constant the presign URL is signed with', () => {
    expect(PRESIGN_EXPIRY_MS).toBe(3600 * 1000);
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `cd apps/api && pnpm exec vitest run src/routes/files.reclaim.test.ts`
Expected: FAIL — cannot resolve `./files.reclaim`.

- [ ] **Step 5: Implement**

```typescript
import { and, eq, isNull, lt } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { files } from '@serverless-saas/database/schema/storage';
import { publishToQueue } from '@serverless-saas/queue';

/** Must match the expiry the presigned URL is signed with. */
export const PRESIGN_EXPIRY_MS = 3600 * 1000;

export function abandonedBefore(now: Date): Date {
  return new Date(now.getTime() - PRESIGN_EXPIRY_MS);
}

/**
 * Expires this tenant's abandoned uploads and queues their bytes for purge.
 *
 * A presign inserts a `pending` row and returns a URL; the client PUTs to S3
 * and calls confirm. When confirm never fires, the bytes sit in S3 with no
 * recorded size — invisible to any sum over `uploaded` rows, forever.
 *
 * Deliberately opportunistic rather than scheduled: the work is scoped to one
 * tenant and bounded by their abandoned uploads in the last hour, so it needs
 * no EventBridge rule of its own. A tenant who never uploads again is never
 * swept, which the one-time backfill covers instead.
 */
export async function reclaimAbandonedUploads(tenantId: string): Promise<number> {
  const rows = await db
    .update(files)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(and(
      eq(files.tenantId, tenantId),
      eq(files.status, 'pending'),
      isNull(files.deletedAt),
      lt(files.createdAt, abandonedBefore(new Date())),
    ))
    .returning({ key: files.key });

  const queueUrl = process.env.SQS_PROCESSING_QUEUE_URL;
  if (!queueUrl) {
    console.error('SQS_PROCESSING_QUEUE_URL unset — abandoned uploads expired but not purged');
    return rows.length;
  }

  for (const row of rows) {
    await publishToQueue(queueUrl, {
      type: 'storage.purge',
      payload: { tenantId, key: row.key },
    });
  }

  return rows.length;
}
```

- [ ] **Step 6: Call it from presign**

At the top of the `/upload` handler in `apps/api/src/routes/files.ts`, after the permission check and before the quota gate, so reclaimed bytes are not counted against the tenant:

```typescript
    // Reclaim first: an abandoned upload's bytes should not count against the
    // quota of the person trying to upload again.
    await reclaimAbandonedUploads(tenantId);
```

- [ ] **Step 7: Run tests and type-check**

Run: `cd apps/api && pnpm exec vitest run src/routes/files.reclaim.test.ts && pnpm type-check`
Expected: PASS, 2 tests; no type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/foundation/database apps/api/src/routes/files.reclaim.ts apps/api/src/routes/files.reclaim.test.ts apps/api/src/routes/files.ts
git commit -m "feat(storage): expire and reclaim abandoned uploads"
```

---

### Task 8: Send `size` from every caller

Seven call sites. Until all of them ship, the gate in Task 4 does nothing for the ones that don't — which is why `size` is still optional.

**Files:**
- Modify: `apps/web/components/platform/files/UploadFileModal.tsx:130`
- Modify: `apps/web/components/platform/chat/useFileUpload.ts:85`
- Modify: `apps/web/components/platform/ImageUpload.tsx:35`
- Modify: `apps/web/components/platform/board/CreateTaskDialog.tsx:87`
- Modify: `apps/web/components/platform/agents/avatar-builder/saveAvatarAsset.ts:10`
- Modify: `apps/web/hooks/useTaskMutations.ts:144`
- Modify: `apps/agent-orchestrator/src/persistence.ts:255`
- Modify: `apps/web/components/platform/chat/useFileUpload.test.ts`
- Modify: `apps/web/components/platform/agents/avatar-builder/saveAvatarAsset.test.ts`
- Modify: `apps/agent-orchestrator/src/__tests__/generatedFileUpload.test.ts`

**Interfaces:**
- Consumes: `/files/upload` accepting `size` (Task 4).
- Produces: nothing new.

- [ ] **Step 1: Write the failing assertions in the three existing tests**

In `apps/web/components/platform/chat/useFileUpload.test.ts`, extend the existing presign assertion:

```typescript
    const [, presignBody] = uploadCalls[0];
    expect(presignBody).toMatchObject({ size: expect.any(Number) });
```

In `apps/web/components/platform/agents/avatar-builder/saveAvatarAsset.test.ts`:

```typescript
    expect(vi.mocked(api.post).mock.calls[0][1]).toMatchObject({ size: expect.any(Number) });
```

In `apps/agent-orchestrator/src/__tests__/generatedFileUpload.test.ts`:

```typescript
    const presignBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(presignBody.size).toEqual(expect.any(Number));
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/web && pnpm exec vitest run components/platform/chat/useFileUpload.test.ts components/platform/agents/avatar-builder/saveAvatarAsset.test.ts`
Then: `cd apps/agent-orchestrator && pnpm exec vitest run src/__tests__/generatedFileUpload.test.ts`
Expected: FAIL — `size` is undefined in each presign body.

- [ ] **Step 3: Add `size` at all seven call sites**

Each site already holds the `File` or `Blob` it is about to upload. Add `size: file.size` (or `blob.size`) to the presign request body. For the orchestrator, the generated file's byte length is the value — use the `Buffer`'s `.length` rather than a string length, which differs for multi-byte content.

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && pnpm exec vitest run components/platform/chat components/platform/agents`
Then: `cd apps/agent-orchestrator && pnpm exec vitest run`
Expected: PASS.

- [ ] **Step 5: Verify no call site was missed**

Run: `grep -rn "files/upload" apps/web apps/agent-orchestrator --include="*.ts" --include="*.tsx" | grep -v test`
Expected: seven lines; inspect each and confirm the adjacent body includes `size`.

- [ ] **Step 6: Commit**

```bash
git add apps/web apps/agent-orchestrator
git commit -m "feat(storage): send declared file size on every presign request"
```

---

### Task 9: Meter above 80%

**Files:**
- Create: `apps/web/components/platform/files/hooks/useStorageUsage.ts`
- Create: `apps/web/components/platform/files/components/StorageMeter.tsx`
- Create: `apps/web/components/platform/files/components/StorageMeter.test.tsx`
- Modify: `apps/web/components/platform/files/FilesList.tsx` — render the meter above the filter row.

**Interfaces:**
- Consumes: `GET /api/v1/files/usage` (Task 6).
- Produces:
  - `useStorageUsage(): { usedBytes: number; limitBytes: number; percent: number; unlimited: boolean } | null`
  - `<StorageMeter percent={number} usedBytes={number} limitBytes={number} />`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StorageMeter, shouldShowMeter } from './StorageMeter';

describe('shouldShowMeter', () => {
  it('stays hidden under 80%, which is the whole point of the feature', () => {
    // Storage limits are unadvertised. A meter at ordinary usage would be the
    // product telling every user about a ceiling they will never reach.
    expect(shouldShowMeter({ percent: 79, unlimited: false })).toBe(false);
  });

  it('appears at exactly 80%', () => {
    expect(shouldShowMeter({ percent: 80, unlimited: false })).toBe(true);
  });

  it('never appears for unlimited plans', () => {
    expect(shouldShowMeter({ percent: 100, unlimited: true })).toBe(false);
  });
});

describe('StorageMeter', () => {
  it('names the concrete numbers, since nothing else in the product does', () => {
    render(<StorageMeter percent={85} usedBytes={17 * 1024 ** 3} limitBytes={20 * 1024 ** 3} />);
    expect(screen.getByText(/17 GB of 20 GB/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && pnpm exec vitest run components/platform/files/components/StorageMeter.test.tsx`
Expected: FAIL — cannot resolve `./StorageMeter`.

- [ ] **Step 3: Implement the hook**

```typescript
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

interface StorageUsage {
    usedBytes: number;
    limitBytes: number;
    percent: number;
    unlimited: boolean;
}

export function useStorageUsage(): StorageUsage | null {
    const { data } = useQuery({
        queryKey: ['storage-usage'],
        queryFn: () => api.get<{ data: StorageUsage }>('/api/v1/files/usage'),
    });
    return data?.data ?? null;
}
```

- [ ] **Step 4: Implement the component**

```tsx
"use client";

const GB = 1024 ** 3;
const VISIBLE_AT_PERCENT = 80;

/**
 * Storage limits are an unadvertised abuse ceiling, so the meter stays hidden
 * during ordinary use and appears only once a tenant is close enough that being
 * blocked is a real prospect.
 */
export function shouldShowMeter(usage: { percent: number; unlimited: boolean }): boolean {
    if (usage.unlimited) return false;
    return usage.percent >= VISIBLE_AT_PERCENT;
}

function formatGb(bytes: number): string {
    return `${Math.round(bytes / GB)} GB`;
}

export function StorageMeter({ percent, usedBytes, limitBytes }: {
    percent: number; usedBytes: number; limitBytes: number;
}) {
    return (
        <div className="flex items-center gap-3 px-4 py-2 rounded-lg bg-secondary border border-border text-sm">
            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-shimmer-accent" style={{ width: `${percent}%` }} />
            </div>
            <span className="text-muted-foreground whitespace-nowrap">
                {formatGb(usedBytes)} of {formatGb(limitBytes)} used
            </span>
        </div>
    );
}
```

`bg-shimmer-accent` rather than `bg-primary`: the pale rose `--primary` fails WCAG AA on the light theme, which `FilesList.tsx` already documents at its "ready to work with" banner.

- [ ] **Step 5: Render it in Drive**

In `FilesList.tsx`, above the filter row:

```tsx
    const storageUsage = useStorageUsage();
```

```tsx
                    {storageUsage && shouldShowMeter(storageUsage) && (
                        <StorageMeter
                            percent={storageUsage.percent}
                            usedBytes={storageUsage.usedBytes}
                            limitBytes={storageUsage.limitBytes}
                        />
                    )}
```

- [ ] **Step 6: Run tests, lint and type-check**

Run: `cd apps/web && pnpm exec vitest run components/platform/files && npx eslint components/platform/files && pnpm type-check`
Expected: PASS; no lint or type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/platform/files
git commit -m "feat(storage): show a usage meter only once a tenant nears the ceiling"
```

---

### Task 10: Raise the seeded plan limits

**Files:**
- Modify: `packages/foundation/database/seeds/plan-entitlements.ts:26,46,66,86`
- Create: `packages/foundation/database/seeds/plan-entitlements.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks.

Seeds only apply to newly seeded plans. Existing `plan_entitlements` rows keep the old values, so this task also re-seeds. Shipping enforcement without it would enforce the old 1GB free limit — twenty times tighter than intended, and enough to block real tenants.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('seeded storage limits', () => {
  const source = readFileSync(join(__dirname, 'plan-entitlements.ts'), 'utf8');

  it('gives free 20GB, not the original 1GB', () => {
    // 1GB was tight enough to read as stingy and to block ordinary use. The
    // ceiling exists to stop free file hosting, not to sell upgrades.
    expect(source).toMatch(/free[\s\S]*?storage_gb:\s*\{\s*valueLimit:\s*20\s*\}/);
  });

  it('gives enterprise unlimited rather than a number', () => {
    // Enterprise storage is pay-as-you-go, so it must resolve unlimited and
    // skip both gates. A numeric limit would block a paying customer.
    expect(source).toMatch(/enterprise[\s\S]*?storage_gb:\s*\{\s*unlimited:\s*true\s*\}/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/foundation/database && pnpm exec vitest run seeds/plan-entitlements.test.ts`
Expected: FAIL — free is still `valueLimit: 1`.

- [ ] **Step 3: Update the seeds**

| Plan | Line | From | To |
|---|---|---|---|
| free | 26 | `{ valueLimit: 1 }` | `{ valueLimit: 20 }` |
| starter | 46 | `{ valueLimit: 10 }` | `{ valueLimit: 200 }` |
| business | 66 | `{ valueLimit: 100 }` | `{ valueLimit: 1_000 }` |
| enterprise | 86 | `{ valueLimit: 1_000 }` | `{ unlimited: true }` |

- [ ] **Step 4: Run the test**

Run: `cd packages/foundation/database && pnpm exec vitest run seeds/plan-entitlements.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Re-seed the existing rows and clear the cache**

Existing rows do not pick these up on their own, and `entitlementsMiddleware` caches the resolved map under `tenant:{tenantId}:entitlements`. Both must be dealt with or the new limits stay invisible until the TTL lapses.

Run the seed against `DATABASE_URL`, then invalidate the entitlement cache keys for affected tenants. Verify by requesting `GET /api/v1/files/usage` as a free tenant and confirming `limitBytes` is `21474836480`.

- [ ] **Step 6: Commit**

```bash
git add packages/foundation/database/seeds
git commit -m "feat(storage): raise seeded storage limits, enterprise to unlimited"
```

---

### Task 11: Require `size`

Only after Task 8 is deployed everywhere — including a manual `pm2 restart agent-orchestrator`, which `./deploy.sh` does not do.

**Files:**
- Modify: `apps/api/src/routes/files.ts` — schema and gate.
- Modify: `apps/api/src/routes/files.upload.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `/files/upload` rejecting a request without `size`.

- [ ] **Step 1: Confirm no size-less requests remain**

Check the API logs for presign requests without `size` since the Task 8 deploy. If any appear, find the caller and fix it before continuing — this step is the gate, not a formality.

- [ ] **Step 2: Update the test**

Replace the optional-size assertion in `files.upload.test.ts`:

```typescript
  it('requires size, now that every caller sends it', () => {
    expect(source).toMatch(/size:\s*z\.number\(\)\.int\(\)\.positive\(\)(?!\.optional)/);
  });

  it('has no unguarded path left that skips the gate', () => {
    // The `if (size !== undefined)` wrapper existed only for the migration
    // window. Leaving it means an omitted size silently skips enforcement.
    expect(source).not.toMatch(/if\s*\(size\s*!==\s*undefined\)/);
  });
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd apps/api && pnpm exec vitest run src/routes/files.upload.test.ts`
Expected: FAIL — `size` is still `.optional()`.

- [ ] **Step 4: Make it required**

Drop `.optional()` from the schema, and remove the `if (size !== undefined)` wrapper so the gate always runs.

- [ ] **Step 5: Run tests and type-check**

Run: `cd apps/api && pnpm exec vitest run src/routes && pnpm type-check`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/files.ts apps/api/src/routes/files.upload.test.ts
git commit -m "feat(storage): require declared size on presign"
```

---

### Task 12: Backfill script

**Files:**
- Create: `scripts/backfill-storage-purge.ts`

**Interfaces:**
- Consumes: the `storage.purge` job (Task 5).
- Produces: nothing consumed by other tasks.

Manual, never automatic, and never part of a migration: it deletes real S3 objects in bulk. It must report what it intends to delete and refuse to act without an explicit flag.

- [ ] **Step 1: Write the script**

```typescript
/**
 * One-time reclamation of objects the old delete path left behind.
 *
 * Two populations, both invisible to any sum over `uploaded` rows and both
 * billing indefinitely:
 *   - soft-deleted files, whose S3 objects were never removed
 *   - `pending` rows older than the presign expiry, whose uploads never confirmed
 *
 * Dry by default. Deleting is irreversible, so --execute is required and the
 * intended set should be inspected first.
 */
import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { files } from '@serverless-saas/database/schema/storage';
import { publishToQueue } from '@serverless-saas/queue';

const execute = process.argv.includes('--execute');
const cutoff = new Date(Date.now() - 3600 * 1000);

async function main() {
  const deleted = await db.select({ id: files.id, tenantId: files.tenantId, key: files.key })
    .from(files).where(and(eq(files.status, 'deleted'), isNotNull(files.deletedAt)));

  const abandoned = await db.select({ id: files.id, tenantId: files.tenantId, key: files.key })
    .from(files).where(and(eq(files.status, 'pending'), lt(files.createdAt, cutoff)));

  console.log(`soft-deleted rows with objects still in S3: ${deleted.length}`);
  console.log(`abandoned pending uploads older than 1h:    ${abandoned.length}`);

  if (!execute) {
    console.log('\nDry run. Re-run with --execute to enqueue purges.');
    return;
  }

  const queueUrl = process.env.SQS_PROCESSING_QUEUE_URL;
  if (!queueUrl) throw new Error('SQS_PROCESSING_QUEUE_URL is unset — refusing to run');

  for (const row of [...deleted, ...abandoned]) {
    await publishToQueue(queueUrl, {
      type: 'storage.purge',
      payload: { tenantId: row.tenantId, key: row.key },
    });
  }

  await db.update(files).set({ status: 'expired', updatedAt: new Date() })
    .where(and(eq(files.status, 'pending'), lt(files.createdAt, cutoff)));

  console.log(`enqueued ${deleted.length + abandoned.length} purge jobs`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Dry-run it**

Run: `pnpm exec tsx scripts/backfill-storage-purge.ts`
Expected: two counts and the dry-run notice. Inspect the counts before going further.

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-storage-purge.ts
git commit -m "chore(storage): backfill script for objects the old delete path left behind"
```

---

## Deployment order

The sequence is load-bearing, and steps 2 and 4 are the ones that get skipped:

1. Tasks 1-7, 9, 10, 12 — API, worker, web, seeds. `size` still optional.
2. Re-seed `plan_entitlements` and clear the entitlement cache. Without this, free enforces at the old 1GB.
3. Deploy web **and** the orchestrator with Task 8. `./deploy.sh` restarts only `web-frontend` and `api` — run `pm2 restart agent-orchestrator` by hand.
4. Confirm no size-less presign requests remain in the logs.
5. Task 11 — require `size`.
6. Run Task 12's backfill with `--execute` once the purge handler is confirmed working on live traffic.

Deploy the Lambda and the frontend together: `apps/api` and `packages/foundation/storage` both change, and stale `dist/` in a foundation package makes `sam deploy` report no changes while shipping old code.

## Verification

- `pnpm type-check` and `pnpm lint` clean at the repo root.
- Upload a file over 500MB → 413 with `file_too_large` naming the cap.
- Upload as a tenant with under 500MB of headroom → 413 with `storage_quota_exceeded`.
- Tamper with the declared size (declare small, send large) → S3 itself rejects the PUT.
- Delete a file → the row goes `deleted`, and the S3 object is gone shortly after.
- Presign, never confirm, wait an hour, presign again → the abandoned row is `expired` and its object purged.
- A tenant above 80% sees the meter; one below 80% sees nothing; an unlimited tenant never sees it.
