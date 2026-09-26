# Products Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a "product" from a loose image file into a saved, AI-named record (name, description, price, source link, several images). Users add products by pasting a link or dropping photos, with no typing, and Olmo receives real product facts.

**Architecture:**
- **Data:** a new tenant-scoped `creative_products` table in the agent-platform schema.
- **API:** CRUD routes in the agent-platform package, plus AI naming. The API Lambda downloads the image and relays it to a new orchestrator internal route, which calls the inference gateway (`gemini-3.6-flash`).
- **Link import:** the existing route now also saves a product.
- **Web:** the Products tab is rebuilt as its own `ProductsPanel.tsx` around these routes. A new `product` brief-selection kind carries name, description and price to Olmo.
- **Olmo:** gets one additive prompt block for a one-line product check.

**Tech Stack:** Drizzle ORM + drizzle-kit (Postgres), Hono (API Lambda and orchestrator), Vitest, Next.js + React Query + shadcn/ui + Radix dropdown, Testing Library + user-event.

**Spec:** `docs/superpowers/specs/2026-09-27-products-library-design.md`

## Global Constraints

- Every DB query filters by `tenant_id`, and tenant id comes from `c.get('requestContext').tenant.id`, never from the request body (CLAUDE.md: "Every DB query must filter by `tenantId`").
- New secure routes mount through `mountApiRoutes` in `products/agent-platform/packages/api/index.ts`, after the existing `api.route('/products/import', productsImportRoutes);` line.
- Permissions: list uses `files`/`read`. Create, describe, import and rename use `files`/`create`. Delete uses `files`/`delete`.
- Placeholder name is exactly `Untitled product`.
- AI name is 60 characters or fewer; AI description is one sentence of 140 characters or fewer, describing only what is visible (no claims, benefits or prices). A renamed name is trimmed and 1–120 characters.
- Photos per product: 1–6. Types: `image/jpeg`, `image/png`, `image/webp`. Upload size cap: 35 MB each (unchanged).
- Naming timeouts: 15 s on the orchestrator's gateway call, 20 s on the API's call to the orchestrator. The image sent for naming is capped at 10 MB; above that, naming is marked failed without calling the orchestrator.
- AI naming is never charged to the tenant. It is cost-logged via `persistCost` with `agentId: 'product-describe'`.
- Prompt changes are additive only: existing contract text in `platformAgent.ts` must not change.
- Tests in `products/agent-platform/packages/api` must live in `__tests__/` (the vitest config only runs that folder).
- `mcp-server/` is not touched. Lambdas are built and deployed from the main checkout, never from a `.claude/worktrees/*` worktree.
- Another session is actively committing to `apps/web/components/platform/chat/CreativeLibrary.tsx` (the voice picker). Keep edits to that file to the minimum stated in Task 7, and rebase on `main` before merging.

## Review Focus

1. **The user renames a product while AI naming is still running.** The user's name must win. Describe only writes where `naming_status = 'pending'`, and rename sets `done`. Pinned in Task 3.
2. **An uploaded or imported image over 10 MB.** Naming is marked failed and the product still works. No 40 MB+ JSON body is sent to the orchestrator. Pinned in Task 2.
3. **A search containing `%` or `_`** (e.g. "50% off"). It must match literally, not as a wildcard. Pinned in Task 2.
4. **A product whose image files were all deleted from Drive.** It must not appear in the list, because a product with no image cannot be attached to a brief. A product with some images left keeps only the surviving ones, in order. Pinned in Task 2.
5. **The model returns fenced JSON, prose around JSON, over-long fields, or no JSON.** Fenced and wrapped JSON parse; long fields are truncated; unparseable output means naming failed, not a crash. Pinned in Task 5.

---

## File Structure

**Create**
- `products/agent-platform/packages/schema/creativeProducts.ts`: the table and the naming-status enum.
- `products/agent-platform/packages/api/lib/productRecords.ts`: DB access and the `ProductRecord` shape, shared by routes, import and backfill.
- `products/agent-platform/packages/api/lib/productNaming.ts`: downloads the main image, calls the orchestrator, writes the result.
- `products/agent-platform/packages/api/routes/products.ts`: list, create, describe, rename, delete.
- `products/agent-platform/packages/api/scripts/backfill-creative-products.ts`: one-off backfill.
- `products/agent-platform/packages/api/__tests__/productRecords.test.ts`
- `products/agent-platform/packages/api/__tests__/productNaming.test.ts`
- `products/agent-platform/packages/api/__tests__/products.routes.test.ts`
- `products/agent-platform/packages/api/__tests__/backfillCreativeProducts.test.ts`
- `apps/agent-orchestrator/src/routes/productDescribe.ts`: `POST /internal/products/describe`.
- `apps/agent-orchestrator/src/routes/productDescribe.test.ts`
- `apps/agent-orchestrator/src/mastra/agents/__tests__/productConfirmationContract.test.ts`
- `apps/web/components/platform/chat/creative-library/productsApi.ts`: web types and calls.
- `apps/web/components/platform/chat/creative-library/storeCreativeImage.ts`: moved out of `CreativeLibrary.tsx`, unchanged.
- `apps/web/components/platform/chat/creative-library/ProductsPanel.tsx`
- `apps/web/components/platform/chat/creative-library/ProductsPanel.test.tsx`

**Modify**
- `products/agent-platform/packages/schema/index.ts`: export the new table.
- `packages/foundation/database/migrations/*`: generated migration.
- `products/agent-platform/packages/api/index.ts`: mount `/products`.
- `products/agent-platform/packages/api/routes/products.import.ts`: save a product.
- `products/agent-platform/packages/api/__tests__/products.import.test.ts`: new response shape.
- `products/agent-platform/packages/api/package.json`: backfill script.
- `apps/agent-orchestrator/src/app.ts`: mount the describe router.
- `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts`: the product confirmation block.
- `apps/web/components/platform/chat/creative-library/creativeBriefModel.ts`: `product` kind.
- `apps/web/components/platform/chat/creative-library/creativeBrief.ts`: brief lines, attachments, parsing.
- `apps/web/components/platform/chat/creative-library/creativeBrief.test.ts`
- `apps/web/components/platform/chat/creative-library/CreativeBriefChips.tsx`: thumbnail for the `product` kind.
- `apps/web/components/platform/chat/CreativeLibrary.tsx`: use the new panel, drop the old one.
- `apps/web/components/platform/chat/CreativeLibrary.test.tsx`: remove the old product tests.

**Delete**
- `apps/web/components/platform/chat/creative-library/ProductImportCard.tsx`, and its test if one exists.

---

### Task 1: `creative_products` table and migration

**Files:**
- Create: `products/agent-platform/packages/schema/creativeProducts.ts`
- Modify: `products/agent-platform/packages/schema/index.ts`
- Modify (generated): `packages/foundation/database/migrations/`

**Interfaces:**
- Produces: `creativeProducts` table, `creativeProductNamingStatusEnum`, and the types `CreativeProduct` and `NewCreativeProduct`, importable from `@serverless-saas/agent-schema/creativeProducts`.

- [ ] **Step 1: Write the schema file**

```ts
// products/agent-platform/packages/schema/creativeProducts.ts
import { sql } from 'drizzle-orm';
import { pgTable, pgEnum, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from '@serverless-saas/database/schema/tenancy';
import { users } from '@serverless-saas/database/schema/auth';

// A tenant's saved product for creative briefs. Deliberately NOT
// creative_library_assets: that table holds platform-owned presets with a
// single required storage_key outside the files table. A product is
// tenant-owned, has several images (files rows, so they stay in Drive) and a
// naming state for AI naming.
export const creativeProductNamingStatusEnum = pgEnum('creative_product_naming_status', ['pending', 'done', 'failed']);

export const creativeProducts = pgTable('creative_products', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  description: text('description'),
  price: text('price'),
  sourceUrl: text('source_url'),
  // Ordered; the first id is the main image. No FK (Postgres can't FK array
  // elements) — reads drop ids whose files row is gone.
  imageFileIds: uuid('image_file_ids').array().notNull().default(sql`'{}'::uuid[]`),
  namingStatus: creativeProductNamingStatusEnum('naming_status').notNull().default('done'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  tenantCreatedIdx: index('creative_products_tenant_created_idx').on(t.tenantId, t.createdAt),
}));

export type CreativeProduct = typeof creativeProducts.$inferSelect;
export type NewCreativeProduct = typeof creativeProducts.$inferInsert;
```

- [ ] **Step 2: Export it from the schema barrel**

In `products/agent-platform/packages/schema/index.ts`, add after `export * from './creativeLibraryAssets';`:

```ts
export * from './creativeProducts';
```

- [ ] **Step 3: Type-check the schema package**

Run: `pnpm --filter @serverless-saas/agent-schema type-check`
Expected: exits 0. If the filter name differs, read `name` in `products/agent-platform/packages/schema/package.json` and use that.

- [ ] **Step 4: Generate the migration**

Run: `cd packages/foundation/database && pnpm exec drizzle-kit generate`
Expected: a new `migrations/0098_<random>.sql` (the number follows the latest, currently `0097_sad_risque.sql`).

Open it. It must contain only:
- `CREATE TYPE "public"."creative_product_naming_status" AS ENUM('pending', 'done', 'failed');`
- `CREATE TABLE ... "creative_products"`
- its two foreign keys and the index.

If it contains anything else (drift from other tables), stop and report it rather than editing it out blindly.

- [ ] **Step 5: Build the schema package**

The API imports this package's `dist/`, so build it now.

Run: `pnpm --filter @serverless-saas/agent-schema build`
Expected: exits 0, and `products/agent-platform/packages/schema/dist/creativeProducts.js` exists.

- [ ] **Step 6: Commit**

```bash
git add products/agent-platform/packages/schema/creativeProducts.ts products/agent-platform/packages/schema/index.ts packages/foundation/database/migrations
git commit -m "feat(schema): add creative_products table"
```

---

### Task 2: Product records and AI naming library (API)

**Files:**
- Create: `products/agent-platform/packages/api/lib/productRecords.ts`
- Create: `products/agent-platform/packages/api/lib/productNaming.ts`
- Test: `products/agent-platform/packages/api/__tests__/productRecords.test.ts`
- Test: `products/agent-platform/packages/api/__tests__/productNaming.test.ts`

**Interfaces:**
- Consumes: `creativeProducts` from `@serverless-saas/agent-schema/creativeProducts` (Task 1).
- Produces, from `lib/productRecords.ts`:
  - `PRODUCT_NAME_PLACEHOLDER = 'Untitled product'`
  - `ALLOWED_PRODUCT_IMAGE_TYPES: Set<string>`
  - `type ProductNamingStatus = 'pending' | 'done' | 'failed'`
  - `interface ProductImage { fileId: string; name: string; type: string; size: number }`
  - `interface ProductRecord { id: string; name: string; description: string | null; price: string | null; sourceUrl: string | null; namingStatus: ProductNamingStatus; images: ProductImage[]; createdAt: string }`
  - `escapeLike(q: string): string`
  - `dropImageless(records: ProductRecord[]): ProductRecord[]`
  - `toProductRecord(row: CreativeProduct, imagesById: Map<string, ProductImage>): ProductRecord`
  - `loadProductImages(tenantId: string, fileIds: string[]): Promise<Map<string, ProductImage>>`
  - `listProducts(tenantId: string, opts: { q?: string; limit: number; offset: number }): Promise<ProductRecord[]>`
  - `getProduct(tenantId: string, id: string): Promise<ProductRecord | null>`
  - `createProduct(input: { tenantId: string; createdBy: string | null; name: string; description: string | null; price: string | null; sourceUrl: string | null; imageFileIds: string[]; namingStatus: ProductNamingStatus }): Promise<ProductRecord>`
  - `renameProduct(tenantId: string, id: string, name: string): Promise<ProductRecord | null>`
  - `deleteProduct(tenantId: string, id: string): Promise<boolean>`
  - `applyNamingResult(tenantId: string, id: string, result: { name: string; description: string | null } | null): Promise<void>`
- Produces, from `lib/productNaming.ts`:
  - `MAX_NAMING_IMAGE_BYTES = 10 * 1024 * 1024`
  - `describeProductImage(tenantId: string, image: ProductImage): Promise<{ name: string; description: string | null } | null>`
  - `nameProduct(tenantId: string, id: string): Promise<ProductRecord | null>`

- [ ] **Step 1: Write the failing tests for the pure helpers**

```ts
// products/agent-platform/packages/api/__tests__/productRecords.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import { dropImageless, escapeLike, toProductRecord, PRODUCT_NAME_PLACEHOLDER } from '../lib/productRecords';

const baseRow = {
  id: 'p1', tenantId: 't1', name: 'Serum', description: null, price: null, sourceUrl: null,
  imageFileIds: ['f1', 'f2', 'f3'], namingStatus: 'done' as const, createdBy: null,
  createdAt: new Date('2026-09-27T00:00:00.000Z'), updatedAt: new Date('2026-09-27T00:00:00.000Z'),
};
const img = (fileId: string) => ({ fileId, name: `${fileId}.png`, type: 'image/png', size: 10 });

describe('escapeLike', () => {
  it('escapes LIKE wildcards and the escape character so search matches literally', () => {
    expect(escapeLike('50% off_now\\')).toBe('50\\% off\\_now\\\\');
  });
});

describe('toProductRecord', () => {
  it('keeps images in stored order and drops ids whose file row is gone', () => {
    const record = toProductRecord(baseRow, new Map([['f3', img('f3')], ['f1', img('f1')]]));
    expect(record.images.map(i => i.fileId)).toEqual(['f1', 'f3']);
    expect(record.createdAt).toBe('2026-09-27T00:00:00.000Z');
  });

  it('exports the exact placeholder name', () => {
    expect(PRODUCT_NAME_PLACEHOLDER).toBe('Untitled product');
  });
});

describe('dropImageless', () => {
  it('hides a product whose image files were all deleted, keeps one with some left', () => {
    const allGone = toProductRecord(baseRow, new Map());
    const oneLeft = toProductRecord({ ...baseRow, id: 'p2' }, new Map([['f2', img('f2')]]));
    expect(dropImageless([allGone, oneLeft]).map(p => p.id)).toEqual(['p2']);
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run __tests__/productRecords.test.ts`
Expected: FAIL, "Cannot find module '../lib/productRecords'".

- [ ] **Step 3: Write `lib/productRecords.ts`**

```ts
// products/agent-platform/packages/api/lib/productRecords.ts
import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { files } from '@serverless-saas/database/schema/storage';
import { creativeProducts, type CreativeProduct } from '@serverless-saas/agent-schema/creativeProducts';

export const PRODUCT_NAME_PLACEHOLDER = 'Untitled product';
export const ALLOWED_PRODUCT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type ProductNamingStatus = 'pending' | 'done' | 'failed';
export interface ProductImage { fileId: string; name: string; type: string; size: number }
export interface ProductRecord {
  id: string;
  name: string;
  description: string | null;
  price: string | null;
  sourceUrl: string | null;
  namingStatus: ProductNamingStatus;
  images: ProductImage[];
  createdAt: string;
}

/** Escapes %, _ and \ so user search text matches literally inside ILIKE. */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function toProductRecord(row: CreativeProduct, imagesById: Map<string, ProductImage>): ProductRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: row.price,
    sourceUrl: row.sourceUrl,
    namingStatus: row.namingStatus,
    images: row.imageFileIds.flatMap((fileId) => {
      const image = imagesById.get(fileId);
      return image ? [image] : [];
    }),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function loadProductImages(tenantId: string, fileIds: string[]): Promise<Map<string, ProductImage>> {
  const unique = [...new Set(fileIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: files.id, name: files.name, mimeType: files.mimeType, size: files.size })
    .from(files)
    .where(and(eq(files.tenantId, tenantId), inArray(files.id, unique), isNull(files.deletedAt)));
  return new Map(rows.map((r) => [r.id, { fileId: r.id, name: r.name, type: r.mimeType ?? 'image/png', size: r.size ?? 0 }]));
}

/** A product with no surviving image can't be attached to a brief, so lists hide it. */
export function dropImageless(records: ProductRecord[]): ProductRecord[] {
  return records.filter((p) => p.images.length > 0);
}

async function withImages(tenantId: string, rows: CreativeProduct[]): Promise<ProductRecord[]> {
  const imagesById = await loadProductImages(tenantId, rows.flatMap((r) => r.imageFileIds));
  return dropImageless(rows.map((r) => toProductRecord(r, imagesById)));
}

export async function listProducts(tenantId: string, opts: { q?: string; limit: number; offset: number }): Promise<ProductRecord[]> {
  const q = opts.q?.trim();
  const pattern = q ? `%${escapeLike(q)}%` : null;
  const rows = await db
    .select()
    .from(creativeProducts)
    .where(and(
      eq(creativeProducts.tenantId, tenantId),
      pattern ? or(ilike(creativeProducts.name, pattern), ilike(creativeProducts.description, pattern)) : undefined,
    ))
    .orderBy(desc(creativeProducts.createdAt))
    .limit(opts.limit)
    .offset(opts.offset);
  return withImages(tenantId, rows);
}

export async function getProduct(tenantId: string, id: string): Promise<ProductRecord | null> {
  const [row] = await db
    .select()
    .from(creativeProducts)
    .where(and(eq(creativeProducts.tenantId, tenantId), eq(creativeProducts.id, id)))
    .limit(1);
  if (!row) return null;
  const imagesById = await loadProductImages(tenantId, row.imageFileIds);
  return toProductRecord(row, imagesById);
}

export async function createProduct(input: {
  tenantId: string; createdBy: string | null; name: string; description: string | null;
  price: string | null; sourceUrl: string | null; imageFileIds: string[]; namingStatus: ProductNamingStatus;
}): Promise<ProductRecord> {
  const [row] = await db.insert(creativeProducts).values(input).returning();
  const imagesById = await loadProductImages(input.tenantId, row.imageFileIds);
  return toProductRecord(row, imagesById);
}

export async function renameProduct(tenantId: string, id: string, name: string): Promise<ProductRecord | null> {
  // A user rename is final: naming_status becomes 'done' so an AI naming
  // result that lands later (applyNamingResult) can't overwrite it.
  const [row] = await db
    .update(creativeProducts)
    .set({ name, namingStatus: 'done' })
    .where(and(eq(creativeProducts.tenantId, tenantId), eq(creativeProducts.id, id)))
    .returning();
  if (!row) return null;
  return toProductRecord(row, await loadProductImages(tenantId, row.imageFileIds));
}

export async function deleteProduct(tenantId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(creativeProducts)
    .where(and(eq(creativeProducts.tenantId, tenantId), eq(creativeProducts.id, id)))
    .returning({ id: creativeProducts.id });
  return deleted.length > 0;
}

export async function applyNamingResult(
  tenantId: string, id: string, result: { name: string; description: string | null } | null,
): Promise<void> {
  // Only a still-pending product takes the AI result — see renameProduct.
  // COALESCE keeps a description the link import already found.
  await db
    .update(creativeProducts)
    .set(result
      ? { name: result.name, description: sql`coalesce(${creativeProducts.description}, ${result.description})`, namingStatus: 'done' }
      : { namingStatus: 'failed' })
    .where(and(
      eq(creativeProducts.tenantId, tenantId),
      eq(creativeProducts.id, id),
      eq(creativeProducts.namingStatus, 'pending'),
    ));
}
```

- [ ] **Step 4: Run the helper tests**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run __tests__/productRecords.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing naming tests**

```ts
// products/agent-platform/packages/api/__tests__/productNaming.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const downloadFileMock = vi.fn();
vi.mock('@serverless-saas/storage', () => ({ storageService: { downloadFile: (...a: unknown[]) => downloadFileMock(...a) } }));
const getProductMock = vi.fn();
const applyNamingResultMock = vi.fn();
vi.mock('../lib/productRecords', async (orig) => ({
  ...(await orig<typeof import('../lib/productRecords')>()),
  getProduct: (...a: unknown[]) => getProductMock(...a),
  applyNamingResult: (...a: unknown[]) => applyNamingResultMock(...a),
}));
vi.mock('../db', () => ({ db: {} }));
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { describeProductImage, nameProduct, MAX_NAMING_IMAGE_BYTES } from '../lib/productNaming';

const image = { fileId: 'f1', name: 'x.png', type: 'image/png', size: 3 };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AGENT_ORCHESTRATOR_URL = 'http://orch.test';
  process.env.INTERNAL_SERVICE_KEY = 'key-1';
});

describe('describeProductImage', () => {
  it('sends the image to the orchestrator with the service key and returns the trimmed result', async () => {
    downloadFileMock.mockResolvedValue(Buffer.from('abc'));
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ name: '  Niacinamide serum ', description: ' A dropper bottle. ' }) });

    const result = await describeProductImage('t1', image);

    expect(result).toEqual({ name: 'Niacinamide serum', description: 'A dropper bottle.' });
    expect(downloadFileMock).toHaveBeenCalledWith('t1', 'f1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://orch.test/internal/products/describe');
    expect(init.headers['X-Service-Key']).toBe('key-1');
    expect(JSON.parse(init.body)).toEqual({ tenantId: 't1', imageBase64: Buffer.from('abc').toString('base64'), mimeType: 'image/png' });
  });

  it('skips images over the size cap without calling the orchestrator', async () => {
    downloadFileMock.mockResolvedValue(Buffer.alloc(MAX_NAMING_IMAGE_BYTES + 1));
    expect(await describeProductImage('t1', image)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when the orchestrator fails or returns no name', async () => {
    downloadFileMock.mockResolvedValue(Buffer.from('abc'));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) });
    expect(await describeProductImage('t1', image)).toBeNull();
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ name: '   ' }) });
    expect(await describeProductImage('t1', image)).toBeNull();
  });

  it('returns null when the orchestrator is not configured', async () => {
    delete process.env.AGENT_ORCHESTRATOR_URL;
    expect(await describeProductImage('t1', image)).toBeNull();
    expect(downloadFileMock).not.toHaveBeenCalled();
  });
});

describe('nameProduct', () => {
  it('names a pending product from its main image and returns the fresh record', async () => {
    getProductMock
      .mockResolvedValueOnce({ id: 'p1', namingStatus: 'pending', images: [image] })
      .mockResolvedValueOnce({ id: 'p1', namingStatus: 'done', name: 'Serum', images: [image] });
    downloadFileMock.mockResolvedValue(Buffer.from('abc'));
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ name: 'Serum', description: null }) });

    const record = await nameProduct('t1', 'p1');

    expect(applyNamingResultMock).toHaveBeenCalledWith('t1', 'p1', { name: 'Serum', description: null });
    expect(record?.name).toBe('Serum');
  });

  it('does not call the model for a product that is not pending', async () => {
    getProductMock.mockResolvedValue({ id: 'p1', namingStatus: 'done', images: [image] });
    await nameProduct('t1', 'p1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(applyNamingResultMock).not.toHaveBeenCalled();
  });

  it('marks naming failed when the result is null', async () => {
    getProductMock.mockResolvedValue({ id: 'p1', namingStatus: 'pending', images: [image] });
    downloadFileMock.mockRejectedValue(new Error('File not found: f1'));
    await nameProduct('t1', 'p1');
    expect(applyNamingResultMock).toHaveBeenCalledWith('t1', 'p1', null);
  });

  it('returns null for an unknown product', async () => {
    getProductMock.mockResolvedValue(null);
    expect(await nameProduct('t1', 'nope')).toBeNull();
  });
});
```

- [ ] **Step 6: Run them to confirm they fail**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run __tests__/productNaming.test.ts`
Expected: FAIL, "Cannot find module '../lib/productNaming'".

- [ ] **Step 7: Write `lib/productNaming.ts`**

```ts
// products/agent-platform/packages/api/lib/productNaming.ts
import { storageService } from '@serverless-saas/storage';
import { applyNamingResult, getProduct, type ProductImage, type ProductRecord } from './productRecords';

// Base64 inflates ~33%; 10 MB keeps the relay body well under the gateway's
// 40 MB request cap and the Lambda's memory. Bigger images simply fail naming.
export const MAX_NAMING_IMAGE_BYTES = 10 * 1024 * 1024;
const ORCHESTRATOR_TIMEOUT_MS = 20_000;

/**
 * The API Lambda has no inference-gateway URL, so naming is relayed to the
 * orchestrator (same host as the gateway), like the watchdog's calls.
 * Never throws: any failure returns null and the caller marks naming failed.
 */
export async function describeProductImage(
  tenantId: string, image: ProductImage,
): Promise<{ name: string; description: string | null } | null> {
  const baseUrl = process.env.AGENT_ORCHESTRATOR_URL;
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!baseUrl || !serviceKey) {
    console.error('[productNaming] AGENT_ORCHESTRATOR_URL or INTERNAL_SERVICE_KEY not set — skipping naming');
    return null;
  }
  try {
    const buffer = await storageService.downloadFile(tenantId, image.fileId);
    if (buffer.length > MAX_NAMING_IMAGE_BYTES) {
      console.warn('[productNaming] image over size cap, skipping', { tenantId, fileId: image.fileId, bytes: buffer.length });
      return null;
    }
    const res = await fetch(`${baseUrl}/internal/products/describe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': serviceKey },
      body: JSON.stringify({ tenantId, imageBase64: buffer.toString('base64'), mimeType: image.type }),
      signal: AbortSignal.timeout(ORCHESTRATOR_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('[productNaming] orchestrator returned', res.status, { tenantId, fileId: image.fileId });
      return null;
    }
    const body = await res.json() as { name?: unknown; description?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return null;
    const description = typeof body.description === 'string' && body.description.trim() ? body.description.trim() : null;
    return { name: name.slice(0, 120), description };
  } catch (error) {
    console.error('[productNaming] naming failed', { tenantId, fileId: image.fileId, error: (error as Error).message });
    return null;
  }
}

/** Names a pending product from its main image. Returns the fresh record, or null if the product doesn't exist. */
export async function nameProduct(tenantId: string, id: string): Promise<ProductRecord | null> {
  const product = await getProduct(tenantId, id);
  if (!product) return null;
  if (product.namingStatus !== 'pending') return product;
  const main = product.images[0];
  const result = main ? await describeProductImage(tenantId, main) : null;
  await applyNamingResult(tenantId, id, result);
  return getProduct(tenantId, id);
}
```

- [ ] **Step 8: Run both test files**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run __tests__/productRecords.test.ts __tests__/productNaming.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 9: Type-check**

Run: `cd products/agent-platform/packages/api && pnpm type-check`
Expected: exits 0.

- [ ] **Step 10: Commit**

```bash
git add products/agent-platform/packages/api/lib/productRecords.ts products/agent-platform/packages/api/lib/productNaming.ts products/agent-platform/packages/api/__tests__/productRecords.test.ts products/agent-platform/packages/api/__tests__/productNaming.test.ts
git commit -m "feat(api): product records and AI naming relay"
```

---

### Task 3: `/products` routes

**Files:**
- Create: `products/agent-platform/packages/api/routes/products.ts`
- Modify: `products/agent-platform/packages/api/index.ts` (import, plus mount after the `/products/import` line)
- Test: `products/agent-platform/packages/api/__tests__/products.routes.test.ts`

**Interfaces:**
- Consumes: everything `lib/productRecords.ts` and `lib/productNaming.ts` produce (Task 2).
- Produces the HTTP API the web uses in Task 7. Every success body is `{ data: ProductRecord }` or `{ data: ProductRecord[] }`.
  - `GET /products?q=&limit=&offset=` returns `{ data: ProductRecord[] }`. `limit` defaults to 50 and is capped at 100.
  - `POST /products` with `{ fileIds: string[] }` (1–6 uuids) returns 201 `{ data: ProductRecord }` with `namingStatus: 'pending'`.
  - `POST /products/:id/describe` returns 200 `{ data: ProductRecord }`, or 404.
  - `PATCH /products/:id` with `{ name: string }` returns 200 `{ data: ProductRecord }`, or 404.
  - `DELETE /products/:id` returns 204, or 404.

- [ ] **Step 1: Write the failing route tests**

```ts
// products/agent-platform/packages/api/__tests__/products.routes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const lib = {
  listProducts: vi.fn(), getProduct: vi.fn(), createProduct: vi.fn(),
  renameProduct: vi.fn(), deleteProduct: vi.fn(), loadProductImages: vi.fn(),
};
vi.mock('../lib/productRecords', async (orig) => ({
  ...(await orig<typeof import('../lib/productRecords')>()),
  listProducts: (...a: unknown[]) => lib.listProducts(...a),
  getProduct: (...a: unknown[]) => lib.getProduct(...a),
  createProduct: (...a: unknown[]) => lib.createProduct(...a),
  renameProduct: (...a: unknown[]) => lib.renameProduct(...a),
  deleteProduct: (...a: unknown[]) => lib.deleteProduct(...a),
  loadProductImages: (...a: unknown[]) => lib.loadProductImages(...a),
}));
const nameProductMock = vi.fn();
vi.mock('../lib/productNaming', () => ({ nameProduct: (...a: unknown[]) => nameProductMock(...a) }));
vi.mock('../db', () => ({ db: {} }));

const F1 = '11111111-1111-4111-8111-111111111111';
const F2 = '22222222-2222-4222-8222-222222222222';
const P1 = '33333333-3333-4333-8333-333333333333';
const product = (over: Record<string, unknown> = {}) => ({
  id: P1, name: 'Serum', description: null, price: null, sourceUrl: null, namingStatus: 'done',
  images: [{ fileId: F1, name: 'a.png', type: 'image/png', size: 3 }], createdAt: '2026-09-27T00:00:00.000Z', ...over,
});

async function app(permissions = [
  { resource: 'files', action: 'read' }, { resource: 'files', action: 'create' }, { resource: 'files', action: 'delete' },
], tenantId: string | null = 'tenant-1') {
  const { productsRoutes } = await import('../routes/products');
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('requestContext' as never, { tenant: tenantId ? { id: tenantId } : undefined, permissions } as never);
    c.set('userId' as never, 'user-1' as never);
    await next();
  });
  a.route('/products', productsRoutes);
  return a;
}
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => { vi.clearAllMocks(); });

describe('/products routes', () => {
  it('lists the tenant\'s products with search and paging passed through', async () => {
    lib.listProducts.mockResolvedValue([product()]);
    const res = await (await app()).request('/products?q=serum&limit=500&offset=50');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(1);
    expect(lib.listProducts).toHaveBeenCalledWith('tenant-1', { q: 'serum', limit: 100, offset: 50 });
  });

  it('requires a resolved tenant', async () => {
    const res = await (await app(undefined, null)).request('/products');
    expect(res.status).toBe(400);
    expect(lib.listProducts).not.toHaveBeenCalled();
  });

  it('requires files:read to list', async () => {
    const res = await (await app([{ resource: 'files', action: 'create' }])).request('/products');
    expect(res.status).toBe(403);
  });

  it('creates a pending product from the tenant\'s own image files', async () => {
    lib.loadProductImages.mockResolvedValue(new Map([
      [F1, { fileId: F1, name: 'a.png', type: 'image/png', size: 3 }],
      [F2, { fileId: F2, name: 'b.webp', type: 'image/webp', size: 3 }],
    ]));
    lib.createProduct.mockResolvedValue(product({ namingStatus: 'pending', name: 'Untitled product' }));

    const res = await (await app()).request('/products', json({ fileIds: [F1, F2] }));

    expect(res.status).toBe(201);
    expect(lib.createProduct).toHaveBeenCalledWith({
      tenantId: 'tenant-1', createdBy: 'user-1', name: 'Untitled product', description: null,
      price: null, sourceUrl: null, imageFileIds: [F1, F2], namingStatus: 'pending',
    });
  });

  it('rejects files that are missing, from another tenant, or not images', async () => {
    lib.loadProductImages.mockResolvedValue(new Map([[F1, { fileId: F1, name: 'a.pdf', type: 'application/pdf', size: 3 }]]));
    const res = await (await app()).request('/products', json({ fileIds: [F1, F2] }));
    expect(res.status).toBe(400);
    expect(lib.createProduct).not.toHaveBeenCalled();
  });

  it('rejects more than 6 images', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `1111111${i}-1111-4111-8111-111111111111`);
    const res = await (await app()).request('/products', json({ fileIds: ids }));
    expect(res.status).toBe(400);
  });

  it('describes a product and returns the named record', async () => {
    nameProductMock.mockResolvedValue(product({ name: 'Niacinamide serum' }));
    const res = await (await app()).request(`/products/${P1}/describe`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.name).toBe('Niacinamide serum');
    expect(nameProductMock).toHaveBeenCalledWith('tenant-1', P1);
  });

  it('404s describe for a product the tenant does not own', async () => {
    nameProductMock.mockResolvedValue(null);
    const res = await (await app()).request(`/products/${P1}/describe`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('renames with a trimmed name', async () => {
    lib.renameProduct.mockResolvedValue(product({ name: 'My serum' }));
    const res = await (await app()).request(`/products/${P1}`, { ...json({ name: '  My serum  ' }), method: 'PATCH' });
    expect(res.status).toBe(200);
    expect(lib.renameProduct).toHaveBeenCalledWith('tenant-1', P1, 'My serum');
  });

  it('rejects an empty or over-long rename', async () => {
    const a = await app();
    expect((await a.request(`/products/${P1}`, { ...json({ name: '   ' }), method: 'PATCH' })).status).toBe(400);
    expect((await a.request(`/products/${P1}`, { ...json({ name: 'x'.repeat(121) }), method: 'PATCH' })).status).toBe(400);
    expect(lib.renameProduct).not.toHaveBeenCalled();
  });

  it('deletes, and 404s an unknown product', async () => {
    lib.deleteProduct.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const a = await app();
    expect((await a.request(`/products/${P1}`, { method: 'DELETE' })).status).toBe(204);
    expect((await a.request(`/products/${P1}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('requires files:delete to delete', async () => {
    const res = await (await app([{ resource: 'files', action: 'read' }])).request(`/products/${P1}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  it('404s a malformed product id without touching the db', async () => {
    const res = await (await app()).request('/products/not-a-uuid', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(lib.deleteProduct).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run __tests__/products.routes.test.ts`
Expected: FAIL, "Cannot find module '../routes/products'".

- [ ] **Step 3: Write `routes/products.ts`**

```ts
// products/agent-platform/packages/api/routes/products.ts
import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';
import {
  ALLOWED_PRODUCT_IMAGE_TYPES, PRODUCT_NAME_PLACEHOLDER,
  createProduct, deleteProduct, listProducts, loadProductImages, renameProduct,
} from '../lib/productRecords';
import { nameProduct } from '../lib/productNaming';

export const productsRoutes = new Hono<AppEnv>();

const uuid = z.string().uuid();
const MAX_IMAGES = 6;

type Action = 'read' | 'create' | 'delete';

/** Resolves the tenant and checks a files permission. Returns the tenant id or a response to return. */
function guard(c: Context<AppEnv>, action: Action): { tenantId: string; userId: string | null } | Response {
  const requestContext = c.get('requestContext') as any;
  const tenantId: string | undefined = requestContext?.tenant?.id;
  if (!tenantId) return c.json({ error: 'Tenant resolution failed', code: 'TENANT_NOT_FOUND' }, 400);
  if (!hasPermission(requestContext?.permissions ?? [], 'files', action)) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
  }
  return { tenantId, userId: (c.get('userId') as string | undefined) ?? null };
}

const notFound = (c: Context<AppEnv>) => c.json({ error: 'Not Found', message: 'Product not found' }, 404);

productsRoutes.get('/', async (c) => {
  const g = guard(c, 'read');
  if (g instanceof Response) return g;
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  const q = c.req.query('q') ?? undefined;
  const data = await listProducts(g.tenantId, { q, limit, offset });
  return c.json({ data });
});

productsRoutes.post(
  '/',
  zValidator('json', z.object({ fileIds: z.array(uuid).min(1).max(MAX_IMAGES) })),
  async (c) => {
    const g = guard(c, 'create');
    if (g instanceof Response) return g;
    const fileIds = [...new Set(c.req.valid('json').fileIds)];
    const images = await loadProductImages(g.tenantId, fileIds);
    const valid = fileIds.every((id) => ALLOWED_PRODUCT_IMAGE_TYPES.has(images.get(id)?.type ?? ''));
    if (!valid) return c.json({ error: 'Invalid images', message: 'Every file must be your own JPG, PNG or WebP image' }, 400);
    const product = await createProduct({
      tenantId: g.tenantId, createdBy: g.userId, name: PRODUCT_NAME_PLACEHOLDER, description: null,
      price: null, sourceUrl: null, imageFileIds: fileIds, namingStatus: 'pending',
    });
    return c.json({ data: product }, 201);
  },
);

productsRoutes.post('/:id/describe', async (c) => {
  const g = guard(c, 'create');
  if (g instanceof Response) return g;
  const id = c.req.param('id');
  if (!uuid.safeParse(id).success) return notFound(c);
  const product = await nameProduct(g.tenantId, id);
  return product ? c.json({ data: product }) : notFound(c);
});

productsRoutes.patch(
  '/:id',
  zValidator('json', z.object({ name: z.string().trim().min(1).max(120) })),
  async (c) => {
    const g = guard(c, 'create');
    if (g instanceof Response) return g;
    const id = c.req.param('id');
    if (!uuid.safeParse(id).success) return notFound(c);
    const product = await renameProduct(g.tenantId, id, c.req.valid('json').name);
    return product ? c.json({ data: product }) : notFound(c);
  },
);

productsRoutes.delete('/:id', async (c) => {
  const g = guard(c, 'delete');
  if (g instanceof Response) return g;
  const id = c.req.param('id');
  if (!uuid.safeParse(id).success) return notFound(c);
  return (await deleteProduct(g.tenantId, id)) ? c.body(null, 204) : notFound(c);
});
```

- [ ] **Step 4: Run the route tests**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run __tests__/products.routes.test.ts`
Expected: PASS, 13 tests.

If the PATCH-validation test fails because `zValidator` returns 400 before trimming: `z.string().trim()` trims before `min`/`max`, so `'   '` fails `min(1)`. Keep the schema as written.

- [ ] **Step 5: Write the failing test for the review-focus race**

This pins Review Focus 1: a user rename must survive a naming result that lands later. Add it to `__tests__/productRecords.test.ts`. It checks that `applyNamingResult` only updates pending rows, by capturing the `where` passed to drizzle.

```ts
// append to products/agent-platform/packages/api/__tests__/productRecords.test.ts
import { PgDialect } from 'drizzle-orm/pg-core';

describe('applyNamingResult', () => {
  it('only updates a product that is still pending, so a user rename wins', async () => {
    vi.resetModules();
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    vi.doMock('../db', () => ({ db: { update: vi.fn(() => ({ set })) } }));
    const { applyNamingResult } = await import('../lib/productRecords');

    await applyNamingResult('t1', 'p1', { name: 'Serum', description: null });

    const sqlText = new PgDialect().sqlToQuery(where.mock.calls[0][0]).sql;
    expect(sqlText).toContain('"naming_status" = $');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ name: 'Serum', namingStatus: 'done' }));
  });
});
```

- [ ] **Step 6: Run it**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run __tests__/productRecords.test.ts`
Expected: PASS, 5 tests. The implementation from Task 2 already satisfies it. If it fails, fix `applyNamingResult` rather than the test.

- [ ] **Step 7: Mount the routes**

In `products/agent-platform/packages/api/index.ts`, add the import after line 31 (`import { productsImportRoutes } ...`):

```ts
import { productsRoutes } from './routes/products';
```

Then, in `mountApiRoutes`, directly after `api.route('/products/import', productsImportRoutes);`, add:

```ts
    api.route('/products', productsRoutes);
```

Order matters: `/products/import` stays registered first, so `POST /products/import` never reaches `productsRoutes`.

- [ ] **Step 8: Type-check and run the package tests**

Run: `cd products/agent-platform/packages/api && pnpm type-check && pnpm exec vitest run`
Expected: type-check exits 0, and all tests pass except the `products.import.test.ts` cases Task 4 changes. At this point those should still pass, because the import route is untouched.

- [ ] **Step 9: Commit**

```bash
git add products/agent-platform/packages/api/routes/products.ts products/agent-platform/packages/api/index.ts products/agent-platform/packages/api/__tests__/products.routes.test.ts products/agent-platform/packages/api/__tests__/productRecords.test.ts
git commit -m "feat(api): products list, create, describe, rename and delete routes"
```

---

### Task 4: Link import saves a product

**Files:**
- Modify: `products/agent-platform/packages/api/routes/products.import.ts:122-194` (the POST handler's tail)
- Modify: `products/agent-platform/packages/api/__tests__/products.import.test.ts`

**Interfaces:**
- Consumes: `createProduct` and `PRODUCT_NAME_PLACEHOLDER` from `lib/productRecords.ts` (Task 2).
- Produces the new response contract for `POST /products/import`:
  - `200 { data: ProductRecord }`. `namingStatus` is `'done'` when the page had a title, and `'pending'` when it didn't, so the web calls describe.
  - `422 { error: 'Import failed', message: 'No product images found on that page' }` when no image could be imported. Nothing is saved.
  - All the existing 400, 403 and 422 paths are unchanged.

- [ ] **Step 1: Update the tests to the new contract (they fail first)**

In `__tests__/products.import.test.ts`, add this mock after the existing `vi.mock('@serverless-saas/storage', ...)` line:

```ts
const createProductMock = vi.fn();
vi.mock('../lib/productRecords', () => ({
  PRODUCT_NAME_PLACEHOLDER: 'Untitled product',
  createProduct: (...a: unknown[]) => createProductMock(...a),
}));
vi.mock('../db', () => ({ db: {} }));
```

In `beforeEach`, add:

```ts
    createProductMock.mockReset().mockImplementation(async (input: Record<string, unknown>) => ({
      id: 'p1', name: input.name, description: input.description, price: input.price, sourceUrl: input.sourceUrl,
      namingStatus: input.namingStatus, images: [], createdAt: '2026-09-27T00:00:00.000Z',
    }));
```

Replace the test `'returns extracted fields and no images when the page has none'` with:

```ts
  it('returns 422 and saves nothing when the page has no importable images', async () => {
    fetchMock.mockResolvedValueOnce({
      ...htmlResponse('<html><head><meta property="og:title" content="Mug"></head></html>'),
      headers: withGet(new Map([['content-type', 'text/html']])),
    });

    const app = await buildApp();
    const res = await app.request('/products/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://shop.example.com/p/1' }),
    });

    expect(res.status).toBe(422);
    expect((await res.json()).message).toBe('No product images found on that page');
    expect(createProductMock).not.toHaveBeenCalled();
    expect(assertPublicHttpUrlMock).toHaveBeenCalledWith('https://shop.example.com/p/1');
  });

  it('saves a named product with every imported image in page order', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ...htmlResponse('<html><head><meta property="og:title" content="Mug"><meta property="og:description" content="Stoneware"><meta property="og:image" content="https://cdn.example.com/a.jpg"></head></html>'),
        headers: withGet(new Map([['content-type', 'text/html']])),
      })
      .mockResolvedValueOnce({ ...imageResponse(new Uint8Array([1, 2, 3])), headers: withGet(new Map([['content-type', 'image/jpeg']])) });
    putFileForTenantMock.mockResolvedValue({ fileId: 'file-a' });

    const app = await buildApp();
    const res = await app.request('/products/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://shop.example.com/p/1' }),
    });

    expect(res.status).toBe(200);
    expect(createProductMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1', createdBy: 'user-1', name: 'Mug', description: 'Stoneware', price: null,
      sourceUrl: 'https://shop.example.com/p/1', imageFileIds: ['file-a'], namingStatus: 'done',
    });
    expect((await res.json()).data.name).toBe('Mug');
  });

  it('saves a pending product with the placeholder name when the page has images but no title', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ...htmlResponse('<html><head><meta property="og:image" content="https://cdn.example.com/a.jpg"></head></html>'),
        headers: withGet(new Map([['content-type', 'text/html']])),
      })
      .mockResolvedValueOnce({ ...imageResponse(new Uint8Array([1])), headers: withGet(new Map([['content-type', 'image/jpeg']])) });
    putFileForTenantMock.mockResolvedValue({ fileId: 'file-a' });

    const app = await buildApp();
    await app.request('/products/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://shop.example.com/p/1' }),
    });

    expect(createProductMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'Untitled product', namingStatus: 'pending' }));
  });
```

Then go through every remaining test in that file that reads `body.data.title`, `body.data.description`, `body.data.price` or `body.data.images`, and change it to assert on `createProductMock`'s argument instead:
- `title` becomes `name`
- `images` becomes `imageFileIds`, which holds file ids only

Tests that expected `200` with zero surviving images now expect `422`.

- [ ] **Step 2: Run them to confirm the changed cases fail**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run __tests__/products.import.test.ts`
Expected: FAIL on the new and changed cases, because the route still returns the old shape.

- [ ] **Step 3: Change the route's tail**

In `routes/products.import.ts`, add this import:

```ts
import { createProduct, PRODUCT_NAME_PLACEHOLDER } from '../lib/productRecords';
```

Replace the final `return c.json({ data: { title: ..., images } });` block with:

```ts
    if (images.length === 0) {
      return c.json({ error: 'Import failed', message: 'No product images found on that page' }, 422);
    }

    const title = extracted.title?.trim().slice(0, 120) || null;
    const product = await createProduct({
      tenantId,
      createdBy: userId,
      name: title ?? PRODUCT_NAME_PLACEHOLDER,
      description: extracted.description?.trim() || null,
      price: extracted.price,
      sourceUrl: url,
      imageFileIds: images.map((image) => image.fileId),
      namingStatus: title ? 'done' : 'pending',
    });

    return c.json({ data: product });
```

`ImportedImage`'s `name`, `type` and `size` fields are now unused by the response. Keep the interface, because `importOneImage` still returns them, and the tests read them via `putFileForTenant`.

- [ ] **Step 4: Run the import tests**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run __tests__/products.import.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Run the whole package and type-check**

Run: `cd products/agent-platform/packages/api && pnpm type-check && pnpm exec vitest run`
Expected: exits 0, all pass.

- [ ] **Step 6: Commit**

```bash
git add products/agent-platform/packages/api/routes/products.import.ts products/agent-platform/packages/api/__tests__/products.import.test.ts
git commit -m "feat(api): product link import saves a product record"
```

---

### Task 5: Orchestrator describe route

**Files:**
- Create: `apps/agent-orchestrator/src/routes/productDescribe.ts`
- Modify: `apps/agent-orchestrator/src/app.ts` (import, plus `app.route('', productDescribeRouter)`)
- Test: `apps/agent-orchestrator/src/routes/productDescribe.test.ts`

**Interfaces:**
- Consumes: `isInternalServiceKey` from `../service-key.js` and `persistCost` from `../cost.js`.
- Produces `POST /internal/products/describe`:
  - Request header: `X-Service-Key`.
  - Body: `{ tenantId: string, imageBase64: string, mimeType: string }`.
  - `200 { name: string, description: string | null }`
  - `401` on a bad key, `400` on a bad body, `502` when the model output can't be used.
  - Also exports `parseProductDescription(raw: string): { name: string; description: string | null } | null` and `productDescribeRouter`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/agent-orchestrator/src/routes/productDescribe.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const { persistCost } = vi.hoisted(() => ({ persistCost: vi.fn() }))
vi.mock('../cost.js', () => ({ persistCost }))

import { productDescribeRouter, parseProductDescription } from './productDescribe.js'

const app = new Hono().route('', productDescribeRouter)
const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  process.env.INTERNAL_SERVICE_KEY = 'key-1'
})

const post = (body: unknown, key = 'key-1') => app.request('/internal/products/describe', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Service-Key': key },
  body: JSON.stringify(body),
})
const gateway = (content: string) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) })

describe('parseProductDescription', () => {
  it('parses plain, fenced, and prose-wrapped JSON', () => {
    expect(parseProductDescription('{"name":"Serum","description":"A bottle."}')).toEqual({ name: 'Serum', description: 'A bottle.' })
    expect(parseProductDescription('```json\n{"name":"Serum"}\n```')).toEqual({ name: 'Serum', description: null })
    expect(parseProductDescription('Here you go: {"name":"Serum","description":""} hope it helps')).toEqual({ name: 'Serum', description: null })
  })

  it('truncates an over-long name to 60 and description to 140 characters', () => {
    const out = parseProductDescription(JSON.stringify({ name: 'n'.repeat(80), description: 'd'.repeat(200) }))
    expect(out?.name).toHaveLength(60)
    expect(out?.description).toHaveLength(140)
  })

  it('returns null for no JSON, bad JSON, or a missing name', () => {
    expect(parseProductDescription('I cannot tell what this is.')).toBeNull()
    expect(parseProductDescription('{"name": ')).toBeNull()
    expect(parseProductDescription('{"description":"x"}')).toBeNull()
  })
})

describe('POST /internal/products/describe', () => {
  it('rejects a wrong service key before calling the model', async () => {
    const res = await post({ tenantId: 't1', imageBase64: 'QUJD', mimeType: 'image/png' }, 'wrong')
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a body without an image', async () => {
    const res = await post({ tenantId: 't1', mimeType: 'image/png' })
    expect(res.status).toBe(400)
  })

  it('sends the image to the gateway and returns the parsed name, logging cost', async () => {
    fetchMock.mockResolvedValue(gateway('{"name":"The Ordinary Niacinamide serum","description":"A white dropper bottle."}'))
    const res = await post({ tenantId: 't1', imageBase64: 'QUJD', mimeType: 'image/png' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: 'The Ordinary Niacinamide serum', description: 'A white dropper bottle.' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.model).toBe('gemini-3.6-flash')
    expect(body.messages[0].content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } })
    expect(persistCost).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', agentId: 'product-describe', model: 'gemini-3.6-flash' }))
  })

  it('returns 502 when the model output has no usable name', async () => {
    fetchMock.mockResolvedValue(gateway('no idea'))
    const res = await post({ tenantId: 't1', imageBase64: 'QUJD', mimeType: 'image/png' })
    expect(res.status).toBe(502)
  })

  it('returns 502 when the gateway errors', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    const res = await post({ tenantId: 't1', imageBase64: 'QUJD', mimeType: 'image/png' })
    expect(res.status).toBe(502)
  })
})
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `cd apps/agent-orchestrator && npx vitest run src/routes/productDescribe.test.ts`
Expected: FAIL, "Failed to resolve import './productDescribe.js'".

- [ ] **Step 3: Write the route**

```ts
// apps/agent-orchestrator/src/routes/productDescribe.ts
import { Hono } from 'hono'
import { isInternalServiceKey } from '../service-key.js'
import { persistCost } from '../cost.js'

const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const MODEL = 'gemini-3.6-flash' // same model analyzeImage.ts uses
const GATEWAY_TIMEOUT_MS = 15_000
const MAX_NAME = 60
const MAX_DESCRIPTION = 140

const PROMPT = `You are naming a product photo for a creative library.
Return ONLY a JSON object: {"name": string, "description": string}.
- name: at most 60 characters. If a brand or product name is readable on the item or its packaging, use it (e.g. "The Ordinary Niacinamide 10% + Zinc 1%"). Otherwise a short plain description of the item (e.g. "Light blue compression t-shirt").
- description: one sentence, at most 140 characters, describing only what is visible. No claims, benefits, prices or marketing words.
- If the photo is not a product (a room, a person, a landscape), still name what it shows.`

export function parseProductDescription(raw: string): { name: string; description: string | null } | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let value: unknown
  try {
    value = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as { name?: unknown; description?: unknown }
  const name = typeof record.name === 'string' ? record.name.trim().slice(0, MAX_NAME).trim() : ''
  if (!name) return null
  const description = typeof record.description === 'string' ? record.description.trim().slice(0, MAX_DESCRIPTION).trim() : ''
  return { name, description: description || null }
}

export const productDescribeRouter = new Hono()

productDescribeRouter.post('/internal/products/describe', async (c) => {
  if (!isInternalServiceKey(c.req.header('X-Service-Key'))) return c.json({ error: 'Unauthorized' }, 401)

  let body: { tenantId?: unknown; imageBase64?: unknown; mimeType?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  const { tenantId, imageBase64, mimeType } = body
  if (typeof tenantId !== 'string' || typeof imageBase64 !== 'string' || !imageBase64 || typeof mimeType !== 'string' || !mimeType.startsWith('image/')) {
    return c.json({ error: 'tenantId, imageBase64 and an image mimeType are required' }, 400)
  }

  try {
    const response = await fetch(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1,
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
    })
    if (!response.ok) {
      console.error(`[productDescribe] gateway HTTP ${response.status} tenantId=${tenantId}`)
      return c.json({ error: 'Naming failed' }, 502)
    }
    const result = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    if (result.usage) {
      // Not charged to the tenant (spec) — logged so the cost stays visible.
      persistCost({
        tenantId, agentId: 'product-describe', workflowId: 'creative-products', model: MODEL,
        inputTokens: result.usage.prompt_tokens ?? 0, outputTokens: result.usage.completion_tokens ?? 0,
      })
    }
    const parsed = parseProductDescription(result.choices?.[0]?.message?.content ?? '')
    if (!parsed) {
      console.warn(`[productDescribe] unusable model output tenantId=${tenantId}`)
      return c.json({ error: 'Naming failed' }, 502)
    }
    return c.json(parsed)
  } catch (error) {
    console.error(`[productDescribe] failed tenantId=${tenantId}:`, (error as Error).message)
    return c.json({ error: 'Naming failed' }, 502)
  }
})
```

Before writing it, check `persistCost`'s parameter names in `apps/agent-orchestrator/src/cost.ts`. `analyzeImage.ts:65-72` calls it with `{ tenantId, agentId, workflowId, model, inputTokens, outputTokens }`. Match that exactly.

- [ ] **Step 4: Run the tests**

Run: `cd apps/agent-orchestrator && npx vitest run src/routes/productDescribe.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Mount the router**

In `apps/agent-orchestrator/src/app.ts`, add after `import { memoryInsightsRouter } from './routes/memoryInsights.js'`:

```ts
import { productDescribeRouter } from './routes/productDescribe.js'
```

After `app.route('', memoryInsightsRouter)`, add:

```ts
app.route('', productDescribeRouter)
```

- [ ] **Step 6: Type-check and run the full orchestrator suite**

Run: `cd apps/agent-orchestrator && npx tsc --noEmit -p . && npx vitest run`
Expected: tsc exits 0 and all tests pass. The baseline on `main` is 769 passed, 9 skipped, plus the new 8.

- [ ] **Step 7: Commit**

```bash
git add apps/agent-orchestrator/src/routes/productDescribe.ts apps/agent-orchestrator/src/routes/productDescribe.test.ts apps/agent-orchestrator/src/app.ts
git commit -m "feat(orchestrator): internal product image describe route"
```

---

### Task 6: `product` brief kind, brief text and chip thumbnail (web)

**Files:**
- Modify: `apps/web/components/platform/chat/creative-library/creativeBriefModel.ts`
- Modify: `apps/web/components/platform/chat/creative-library/creativeBrief.ts`
- Modify: `apps/web/components/platform/chat/creative-library/CreativeBriefChips.tsx:78-80`
- Test: `apps/web/components/platform/chat/creative-library/creativeBrief.test.ts`

**Interfaces:**
- Produces, in `creativeBriefModel.ts`:

```ts
export type ProductNamingStatus = 'pending' | 'done' | 'failed';
export interface ProductRecordSelection {
    kind: 'product';
    id: string;               // creative_products.id
    name: string;
    description: string | null;
    price: string | null;
    sourceUrl: string | null;
    namingStatus: ProductNamingStatus;
    attachment: Attachment;   // the main image
}
export type ProductSelection = ProductImageSelection | ProductUrlSelection | ProductRecordSelection;
```

  The old kinds stay: already-sent messages carry them in their brief marker.
- Produces the brief text for the `product` kind (exact):

```
- Product: <name>
  <description>[ <price>]          (line present only if description or price)
  Source: <sourceUrl>              (line present only if sourceUrl)
  Use the attached product image as the visual reference.
```

  When `namingStatus !== 'done'`, the first line is exactly `- Product: name not known yet — ask the user what this product is before planning.`

- [ ] **Step 1: Write the failing tests**

Append to `creativeBrief.test.ts` (keep its existing imports; add `ProductRecordSelection` to the `creativeBriefModel` import and `mergeCreativeBriefAttachments`, `creativeBriefAttachmentIds`, `parseCreativeBriefDraft` to the `creativeBrief` import if they are not already there):

```ts
const productRecord = (over: Partial<ProductRecordSelection> = {}): ProductRecordSelection => ({
    kind: 'product', id: 'p1', name: 'The Ordinary Niacinamide serum', description: 'A white dropper bottle.',
    price: '₹590', sourceUrl: 'https://theordinary.com/p/1', namingStatus: 'done',
    attachment: { fileId: 'f1', name: 'serum.png', type: 'image/png', size: 3 }, ...over,
});

describe('product record selections', () => {
    it('sends the name, description, price and source, and says an image is attached', () => {
        const brief = { ...createEmptyCreativeBrief(), product: productRecord() };
        const message = buildCreativeBriefMessage('', brief);
        expect(message).toContain('- Product: The Ordinary Niacinamide serum\n  A white dropper bottle. ₹590\n  Source: https://theordinary.com/p/1\n  Use the attached product image as the visual reference.');
    });

    it('omits empty optional lines', () => {
        const brief = { ...createEmptyCreativeBrief(), product: productRecord({ description: null, price: null, sourceUrl: null }) };
        expect(buildCreativeBriefMessage('', brief)).toContain('- Product: The Ordinary Niacinamide serum\n  Use the attached product image as the visual reference.');
    });

    it('tells Olmo to ask when the name is not known yet', () => {
        const brief = { ...createEmptyCreativeBrief(), product: productRecord({ name: 'Untitled product', namingStatus: 'pending', description: null, price: null, sourceUrl: null }) };
        const message = buildCreativeBriefMessage('', brief);
        expect(message).toContain('- Product: name not known yet — ask the user what this product is before planning.');
        expect(message).not.toContain('Untitled product\n');
    });

    it('attaches the main image and hides it from the transcript as a brief attachment', () => {
        const brief = { ...createEmptyCreativeBrief(), product: productRecord() };
        expect(mergeCreativeBriefAttachments(undefined, brief)).toEqual([productRecord().attachment]);
        expect(creativeBriefAttachmentIds(brief)).toEqual(new Set(['f1']));
    });

    it('round-trips through the persisted draft and rejects a record without an attachment', () => {
        const brief = { ...createEmptyCreativeBrief(), product: productRecord() };
        expect(parseCreativeBriefDraft(JSON.stringify(brief)).product).toEqual(productRecord());
        const broken = { ...brief, product: { ...productRecord(), attachment: undefined } };
        expect(parseCreativeBriefDraft(JSON.stringify(broken)).product).toBeNull();
    });

    it('still restores the old product-image kind from earlier messages', () => {
        const old = { kind: 'product-image', id: 'f9', name: '_.jpeg', attachment: { fileId: 'f9', name: '_.jpeg', type: 'image/jpeg', size: 1 } };
        expect(parseCreativeBriefDraft(JSON.stringify({ product: old })).product).toEqual(old);
    });
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `cd apps/web && npx vitest run components/platform/chat/creative-library/creativeBrief.test.ts`
Expected: FAIL. The type `ProductRecordSelection` is missing, and the brief text doesn't match.

- [ ] **Step 3: Add the kind to `creativeBriefModel.ts`**

After the `ProductUrlSelection` interface, add:

```ts
export type ProductNamingStatus = 'pending' | 'done' | 'failed';

/** A saved creative_products row. The only kind new selections use; the two above stay parseable for already-sent briefs. */
export interface ProductRecordSelection {
    kind: 'product';
    id: string;
    name: string;
    description: string | null;
    price: string | null;
    sourceUrl: string | null;
    namingStatus: ProductNamingStatus;
    /** The product's main image. */
    attachment: Attachment;
}
```

Change the union to:

```ts
export type ProductSelection = ProductImageSelection | ProductUrlSelection | ProductRecordSelection;
```

- [ ] **Step 4: Update `creativeBrief.ts`**

Add a helper above `buildCreativeBriefMessage`:

```ts
function productRecordLines(selection: Extract<CreativeSelection, { kind: 'product' }>): string {
    if (selection.namingStatus !== 'done') {
        return '- Product: name not known yet — ask the user what this product is before planning.\n  Use the attached product image as the visual reference.';
    }
    const details = [selection.description, selection.price].filter(Boolean).join(' ');
    return [
        `- Product: ${selection.name}`,
        details ? `  ${details}` : null,
        selection.sourceUrl ? `  Source: ${selection.sourceUrl}` : null,
        '  Use the attached product image as the visual reference.',
    ].filter((line): line is string => line !== null).join('\n');
}
```

In `buildCreativeBriefMessage`, replace the `product ? \`- Product: ...` entry in `lines` with:

```ts
        productSelection?.kind === 'product'
            ? productRecordLines(productSelection)
            : product ? `- Product: ${product}${hasSelectedImage ? '\n  Use the attached product image as the visual reference.' : '\n  Treat the URL as a source to inspect; verify product details before making claims.'}` : null,
```

Guard the old `product` string computation so it only runs for the old kinds. Change the `else` branch:

```ts
    } else if (productSelection?.kind === 'product-image') {
        product = productSelection.name;
    }
```

In both `creativeBriefAttachmentIds` and `mergeCreativeBriefAttachments`, next to the `product-image` line, add:

```ts
        brief.product?.kind === 'product' ? brief.product.attachment.fileId : undefined,
```

and, in `mergeCreativeBriefAttachments`:

```ts
        brief.product?.kind === 'product' ? brief.product.attachment : undefined,
```

In `isProductSelection`, before the final `return`, add:

```ts
    if (value.kind === 'product') {
        return ['pending', 'done', 'failed'].includes(value.namingStatus as string)
            && isStringOrNull(value.description) && isStringOrNull(value.price) && isStringOrNull(value.sourceUrl)
            && isAttachment(value.attachment);
    }
```

- [ ] **Step 5: Add the chip thumbnail**

In `CreativeBriefChips.tsx`, change the first condition of `SelectionThumbnail` from `if (selection.kind === 'product-image') {` to:

```tsx
    if (selection.kind === 'product-image' || selection.kind === 'product') {
```

- [ ] **Step 6: Run the brief tests and the chips tests**

Run: `cd apps/web && npx vitest run components/platform/chat/creative-library/`
Expected: PASS for all files in that folder.

- [ ] **Step 7: Type-check the web app**

Run: `cd apps/web && npx tsc --noEmit -p .`
Expected: exits 0. `CreativeLibrary.tsx` still compiles, because the union only widened.

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/platform/chat/creative-library/creativeBriefModel.ts apps/web/components/platform/chat/creative-library/creativeBrief.ts apps/web/components/platform/chat/creative-library/creativeBrief.test.ts apps/web/components/platform/chat/creative-library/CreativeBriefChips.tsx
git commit -m "feat(web): product record brief selection sends name, description and price"
```

---

### Task 7: Products panel (web)

**Files:**
- Create: `apps/web/components/platform/chat/creative-library/productsApi.ts`
- Create: `apps/web/components/platform/chat/creative-library/storeCreativeImage.ts`
- Create: `apps/web/components/platform/chat/creative-library/ProductsPanel.tsx`
- Test: `apps/web/components/platform/chat/creative-library/ProductsPanel.test.tsx`
- Modify: `apps/web/components/platform/chat/CreativeLibrary.tsx` (remove `ProductsPanel`, `storeCreativeImage`, `PRODUCT_PREFIX` and the `ProductImportCard` import; import the new ones)
- Modify: `apps/web/components/platform/chat/CreativeLibrary.test.tsx` (delete the product `it(...)` cases)
- Delete: `apps/web/components/platform/chat/creative-library/ProductImportCard.tsx`, and `ProductImportCard.test.tsx` if present

**Interfaces:**
- Consumes: the HTTP API from Tasks 3 and 4, and `ProductRecordSelection` and `ProductSelection` from Task 6.
- Produces:
  - `ProductsPanel({ selected, onSelect }: { selected: ProductSelection | null; onSelect: (s: ProductSelection) => void })`
  - `storeCreativeImage(file: File, prefix: string): Promise<Attachment>`, moved verbatim, so `AvatarsPanel` imports it from the new file.

- [ ] **Step 1: Move `storeCreativeImage` into its own file**

Create `creative-library/storeCreativeImage.ts` with the exact body of the current function at `CreativeLibrary.tsx:101-110`:

```ts
// apps/web/components/platform/chat/creative-library/storeCreativeImage.ts
import { api } from '@/lib/api';
import type { Attachment } from '@/types/agent-events';

export async function storeCreativeImage(file: File, prefix: string): Promise<Attachment> {
    const key = `${prefix}${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
    const { data: upload } = await api.post<{ data: { fileId: string; uploadUrl: string } }>('/api/v1/files/upload', {
        filename: file.name, contentType: file.type, key, size: file.size,
    });
    const put = await fetch(upload.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    if (!put.ok) throw new Error('Image upload failed.');
    await api.post(`/api/v1/files/${upload.fileId}/confirm`, { size: file.size });
    return { fileId: upload.fileId, name: file.name, type: file.type, size: file.size };
}
```

Re-read `CreativeLibrary.tsx` first. The other session may have changed this function. Copy whatever is there now.

- [ ] **Step 2: Write `productsApi.ts`**

```ts
// apps/web/components/platform/chat/creative-library/productsApi.ts
import { api } from '@/lib/api';
import type { Attachment } from '@/types/agent-events';
import type { ProductNamingStatus, ProductRecordSelection } from './creativeBriefModel';

export interface ProductRecord {
    id: string;
    name: string;
    description: string | null;
    price: string | null;
    sourceUrl: string | null;
    namingStatus: ProductNamingStatus;
    images: Attachment[];
    createdAt: string;
}

export const PRODUCTS_PAGE_SIZE = 50;

export function listProducts(q: string, offset: number) {
    const params = new URLSearchParams({ limit: String(PRODUCTS_PAGE_SIZE), offset: String(offset) });
    if (q.trim()) params.set('q', q.trim());
    return api.get<{ data: ProductRecord[] }>(`/api/v1/products?${params.toString()}`);
}

export async function createProductFromFiles(fileIds: string[]): Promise<ProductRecord> {
    return (await api.post<{ data: ProductRecord }>('/api/v1/products', { fileIds })).data;
}

export async function importProductFromUrl(url: string): Promise<ProductRecord> {
    return (await api.post<{ data: ProductRecord }>('/api/v1/products/import', { url })).data;
}

export async function describeProduct(id: string): Promise<ProductRecord> {
    return (await api.post<{ data: ProductRecord }>(`/api/v1/products/${id}/describe`)).data;
}

export async function renameProduct(id: string, name: string): Promise<ProductRecord> {
    return (await api.patch<{ data: ProductRecord }>(`/api/v1/products/${id}`, { name })).data;
}

export async function deleteProduct(id: string): Promise<void> {
    await api.del(`/api/v1/products/${id}`);
}

export function productSelection(product: ProductRecord): ProductRecordSelection {
    return {
        kind: 'product', id: product.id, name: product.name, description: product.description,
        price: product.price, sourceUrl: product.sourceUrl, namingStatus: product.namingStatus,
        attachment: product.images[0],
    };
}
```

- [ ] **Step 3: Write the failing panel tests**

```tsx
// apps/web/components/platform/chat/creative-library/ProductsPanel.test.tsx
/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { ProductsPanel } from './ProductsPanel';
import * as productsApi from './productsApi';
import { storeCreativeImage } from './storeCreativeImage';
import type { ProductRecord } from './productsApi';

vi.mock('./storeCreativeImage', () => ({ storeCreativeImage: vi.fn() }));
vi.mock('./productsApi', async (orig) => ({
    ...(await orig<typeof import('./productsApi')>()),
    listProducts: vi.fn(), createProductFromFiles: vi.fn(), importProductFromUrl: vi.fn(),
    describeProduct: vi.fn(), renameProduct: vi.fn(), deleteProduct: vi.fn(),
}));
vi.mock('@/components/platform/files/FileThumbnail', () => ({ FileThumbnail: ({ alt }: { alt: string }) => <span>{alt}</span> }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Radix menus need these in jsdom.
Object.assign(window.HTMLElement.prototype, { hasPointerCapture: () => false, releasePointerCapture: () => {}, scrollIntoView: () => {} });

const image = (fileId: string) => ({ fileId, name: `${fileId}.png`, type: 'image/png', size: 3 });
const record = (over: Partial<ProductRecord> = {}): ProductRecord => ({
    id: 'p1', name: 'Niacinamide serum', description: 'A dropper bottle.', price: null, sourceUrl: null,
    namingStatus: 'done', images: [image('f1')], createdAt: '2026-09-27T00:00:00.000Z', ...over,
});

function renderPanel(onSelect = vi.fn(), selected: Parameters<typeof ProductsPanel>[0]['selected'] = null) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return { onSelect, ...render(<QueryClientProvider client={client}><ProductsPanel selected={selected} onSelect={onSelect} /></QueryClientProvider>) };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(productsApi.listProducts).mockResolvedValue({ data: [] });
});
afterEach(() => vi.useRealTimers());

describe('ProductsPanel', () => {
    it('shows one drop zone and the skip line when there are no products', async () => {
        renderPanel();
        expect(await screen.findByText('Paste a product link or drop photos')).toBeTruthy();
        expect(screen.getByText('You can skip this. Olmo will ask about your product in chat.')).toBeTruthy();
    });

    it('uploads dropped photos, creates a product, selects it, then selects the AI-named version', async () => {
        vi.mocked(storeCreativeImage).mockResolvedValueOnce(image('f1')).mockResolvedValueOnce(image('f2'));
        vi.mocked(productsApi.createProductFromFiles).mockResolvedValue(record({ name: 'Untitled product', namingStatus: 'pending', images: [image('f1'), image('f2')] }));
        vi.mocked(productsApi.describeProduct).mockResolvedValue(record({ images: [image('f1'), image('f2')] }));
        const onSelect = vi.fn();
        const { rerender } = renderPanel(onSelect);
        const files = [new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.png', { type: 'image/png' })];

        fireEvent.drop(await screen.findByTestId('product-drop-zone'), { dataTransfer: { files } });

        await waitFor(() => expect(productsApi.createProductFromFiles).toHaveBeenCalledWith(['f1', 'f2']));
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'product', id: 'p1', namingStatus: 'pending' })));
        // The parent passes the selection back down, as ChatComposer does.
        rerender(<QueryClientProvider client={new QueryClient()}><ProductsPanel selected={{ ...productsApi.productSelection(record({ namingStatus: 'pending' })) }} onSelect={onSelect} /></QueryClientProvider>);
        await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'product', name: 'Niacinamide serum', namingStatus: 'done' })));
    });

    it('does not override a different product the user picked while naming ran', async () => {
        vi.mocked(storeCreativeImage).mockResolvedValue(image('f1'));
        vi.mocked(productsApi.createProductFromFiles).mockResolvedValue(record({ namingStatus: 'pending' }));
        let finishNaming: (r: ProductRecord) => void = () => {};
        vi.mocked(productsApi.describeProduct).mockReturnValue(new Promise(resolve => { finishNaming = resolve; }));
        const onSelect = vi.fn();
        const { rerender } = renderPanel(onSelect);

        fireEvent.drop(await screen.findByTestId('product-drop-zone'), { dataTransfer: { files: [new File(['a'], 'a.png', { type: 'image/png' })] } });
        await waitFor(() => expect(productsApi.describeProduct).toHaveBeenCalled());
        const other = productsApi.productSelection(record({ id: 'p2', name: 'Other' }));
        rerender(<QueryClientProvider client={new QueryClient()}><ProductsPanel selected={other} onSelect={onSelect} /></QueryClientProvider>);
        const callsBefore = onSelect.mock.calls.length;
        await act(async () => finishNaming(record()));

        expect(onSelect.mock.calls.length).toBe(callsBefore);
    });

    it('rejects more than 6 photos without uploading', async () => {
        renderPanel();
        const files = Array.from({ length: 7 }, (_, i) => new File(['x'], `${i}.png`, { type: 'image/png' }));
        fireEvent.drop(await screen.findByTestId('product-drop-zone'), { dataTransfer: { files } });
        expect(toast.error).toHaveBeenCalledWith('Add up to 6 photos of one product at a time.');
        expect(storeCreativeImage).not.toHaveBeenCalled();
    });

    it('imports a pasted link and selects the saved product', async () => {
        vi.mocked(productsApi.importProductFromUrl).mockResolvedValue(record({ sourceUrl: 'https://shop.example.com/p/1' }));
        const onSelect = vi.fn();
        renderPanel(onSelect);
        const input = await screen.findByLabelText('Product link');

        fireEvent.paste(input, { clipboardData: { getData: () => 'https://shop.example.com/p/1' } });

        await waitFor(() => expect(productsApi.importProductFromUrl).toHaveBeenCalledWith('https://shop.example.com/p/1'));
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'product', sourceUrl: 'https://shop.example.com/p/1' })));
        expect(productsApi.describeProduct).not.toHaveBeenCalled();
    });

    it('shows the no-dead-end message when a link cannot be read, and saves nothing', async () => {
        vi.mocked(productsApi.importProductFromUrl).mockRejectedValue(new Error('422'));
        const onSelect = vi.fn();
        renderPanel(onSelect);
        const input = await screen.findByLabelText('Product link');
        fireEvent.change(input, { target: { value: 'https://blocked.example.com/p' } });
        fireEvent.submit(input.closest('form')!);

        expect(await screen.findByRole('alert')).toHaveProperty('textContent', "Couldn't read this page. Drop a product photo instead.");
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('lists products by name, never filename, and shows Naming… while pending', async () => {
        vi.mocked(productsApi.listProducts).mockResolvedValue({ data: [record(), record({ id: 'p2', name: 'Untitled product', namingStatus: 'pending' })] });
        renderPanel();
        expect(await screen.findByText('Niacinamide serum')).toBeTruthy();
        expect(screen.getByText('Naming…')).toBeTruthy();
        expect(screen.queryByText('f1.png')).toBeNull();
    });

    it('selects a product when its card is clicked', async () => {
        vi.mocked(productsApi.listProducts).mockResolvedValue({ data: [record()] });
        const onSelect = vi.fn();
        renderPanel(onSelect);
        fireEvent.click(await screen.findByRole('button', { name: 'Use Niacinamide serum' }));
        expect(onSelect).toHaveBeenCalledWith(productsApi.productSelection(record()));
    });

    it('renames a product inline from the menu', async () => {
        vi.mocked(productsApi.listProducts).mockResolvedValue({ data: [record()] });
        vi.mocked(productsApi.renameProduct).mockResolvedValue(record({ name: 'My serum' }));
        const user = userEvent.setup();
        renderPanel();
        await user.click(await screen.findByRole('button', { name: 'More options for Niacinamide serum' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
        const field = await screen.findByLabelText('Product name');
        await user.clear(field);
        await user.type(field, 'My serum{Enter}');
        await waitFor(() => expect(productsApi.renameProduct).toHaveBeenCalledWith('p1', 'My serum'));
    });

    it('deletes after the undo window, and Undo cancels it', async () => {
        vi.mocked(productsApi.listProducts).mockResolvedValue({ data: [record()] });
        const user = userEvent.setup();
        renderPanel();
        await user.click(await screen.findByRole('button', { name: 'More options for Niacinamide serum' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

        expect(screen.queryByText('Niacinamide serum')).toBeNull();
        const undo = vi.mocked(toast.success).mock.calls[0][1] as { action: { onClick: () => void } };
        act(() => undo.action.onClick());
        expect(await screen.findByText('Niacinamide serum')).toBeTruthy();
        await new Promise(resolve => setTimeout(resolve, 5100));
        expect(productsApi.deleteProduct).not.toHaveBeenCalled();
    }, 10_000);
});
```

- [ ] **Step 4: Run them to confirm they fail**

Run: `cd apps/web && npx vitest run components/platform/chat/creative-library/ProductsPanel.test.tsx`
Expected: FAIL, "Failed to resolve import './ProductsPanel'".

- [ ] **Step 5: Write `ProductsPanel.tsx`**

```tsx
// apps/web/components/platform/chat/creative-library/ProductsPanel.tsx
"use client";

import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ImagePlus, Loader2, MoreHorizontal, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { FileThumbnail } from '@/components/platform/files/FileThumbnail';
import { cn } from '@/lib/utils';
import type { ProductSelection } from './creativeBriefModel';
import { storeCreativeImage } from './storeCreativeImage';
import {
    PRODUCTS_PAGE_SIZE, createProductFromFiles, deleteProduct, describeProduct, importProductFromUrl,
    listProducts, productSelection, renameProduct, type ProductRecord,
} from './productsApi';

const PRODUCT_PREFIX = 'creative-products/';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 35 * 1024 * 1024;
const DELETE_UNDO_MS = 5000;
const LINK_FAILED = "Couldn't read this page. Drop a product photo instead.";

export function ProductsPanel({ selected, onSelect }: { selected: ProductSelection | null; onSelect: (selection: ProductSelection) => void }) {
    const queryClient = useQueryClient();
    const inputRef = useRef<HTMLInputElement>(null);
    const mountedRef = useRef(true);
    const selectedIdRef = useRef<string | null>(null);
    const pendingDeletes = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const [search, setSearch] = useState('');
    const [link, setLink] = useState('');
    const [busy, setBusy] = useState<'link' | 'photos' | null>(null);
    const [linkError, setLinkError] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);
    const [hidden, setHidden] = useState<Set<string>>(() => new Set());
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    selectedIdRef.current = selected?.kind === 'product' ? selected.id : null;

    const { data, isPending, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
        queryKey: ['creative-products', search.trim()],
        initialPageParam: 0,
        queryFn: ({ pageParam }) => listProducts(search, pageParam),
        getNextPageParam: (last, pages) => last.data.length === PRODUCTS_PAGE_SIZE ? pages.length * PRODUCTS_PAGE_SIZE : undefined,
    });
    const products = (data?.pages.flatMap(page => page.data) ?? []).filter(product => !hidden.has(product.id));
    const isEmpty = !isPending && !isError && products.length === 0 && !search.trim();

    useEffect(() => {
        mountedRef.current = true;
        const deletes = pendingDeletes.current;
        return () => {
            mountedRef.current = false;
            // Leaving the panel commits any delete still inside its undo window.
            for (const [id, timer] of deletes) { clearTimeout(timer); void deleteProduct(id).catch(() => {}); }
            deletes.clear();
        };
    }, []);

    const refresh = () => queryClient.invalidateQueries({ queryKey: ['creative-products'] });
    const unhide = (id: string) => setHidden(prev => { const next = new Set(prev); next.delete(id); return next; });

    async function nameIfPending(product: ProductRecord) {
        if (product.namingStatus !== 'pending') return;
        try {
            const named = await describeProduct(product.id);
            // Only update the brief if the user still has this product picked.
            if (mountedRef.current && selectedIdRef.current === named.id) onSelect(productSelection(named));
        } catch {
            // Naming failed: the card and brief keep the placeholder; Olmo asks.
        } finally {
            await refresh();
        }
    }

    async function addPhotos(fileList: FileList | File[]) {
        const files = Array.from(fileList);
        if (files.length === 0 || busy) return;
        if (files.length > MAX_PHOTOS) { toast.error(`Add up to ${MAX_PHOTOS} photos of one product at a time.`); return; }
        if (files.some(file => !IMAGE_TYPES.has(file.type))) { toast.error('Choose JPG, PNG, or WebP images.'); return; }
        if (files.some(file => file.size > MAX_PHOTO_BYTES)) { toast.error('Product images must be under 35 MB.'); return; }
        setBusy('photos');
        setLinkError(null);
        try {
            const attachments = await Promise.all(files.map(file => storeCreativeImage(file, PRODUCT_PREFIX)));
            const product = await createProductFromFiles(attachments.map(attachment => attachment.fileId));
            await refresh();
            if (!mountedRef.current) return;
            selectedIdRef.current = product.id;
            onSelect(productSelection(product));
            void nameIfPending(product);
        } catch {
            if (mountedRef.current) toast.error('Could not add the product photos. Please try again.');
        } finally {
            if (mountedRef.current) setBusy(null);
        }
    }

    async function addLink(raw: string) {
        if (busy) return;
        let parsed: URL;
        try {
            parsed = new URL(raw.trim());
            if (parsed.protocol !== 'https:') throw new Error('Invalid protocol');
        } catch {
            setLinkError('Enter a product link that starts with https://');
            return;
        }
        setBusy('link');
        setLinkError(null);
        try {
            const product = await importProductFromUrl(parsed.href);
            await refresh();
            if (!mountedRef.current) return;
            setLink('');
            selectedIdRef.current = product.id;
            onSelect(productSelection(product));
            void nameIfPending(product);
        } catch {
            if (mountedRef.current) setLinkError(LINK_FAILED);
        } finally {
            if (mountedRef.current) setBusy(null);
        }
    }

    function onPasteLink(event: ClipboardEvent<HTMLInputElement>) {
        const text = event.clipboardData.getData('text').trim();
        if (!text.startsWith('https://')) return;
        event.preventDefault();
        setLink(text);
        void addLink(text);
    }

    async function commitRename(product: ProductRecord) {
        const name = renameValue.trim().slice(0, 120);
        setRenamingId(null);
        if (!name || name === product.name) return;
        try {
            const updated = await renameProduct(product.id, name);
            if (selectedIdRef.current === updated.id) onSelect(productSelection(updated));
            await refresh();
        } catch {
            toast.error('Could not rename the product.');
        }
    }

    function removeProduct(product: ProductRecord) {
        setHidden(prev => new Set(prev).add(product.id));
        const timer = setTimeout(() => {
            pendingDeletes.current.delete(product.id);
            deleteProduct(product.id).then(refresh).catch(() => {
                if (!mountedRef.current) return;
                unhide(product.id);
                toast.error('Could not delete the product.');
            });
        }, DELETE_UNDO_MS);
        pendingDeletes.current.set(product.id, timer);
        toast.success('Product deleted', {
            action: { label: 'Undo', onClick: () => { clearTimeout(timer); pendingDeletes.current.delete(product.id); unhide(product.id); } },
        });
    }

    return <div className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">Products</h2>
            {!isEmpty && <div className="relative w-full sm:w-64">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search products" aria-label="Search products" className="h-9 pl-9" />
            </div>}
        </div>
        <div
            data-testid="product-drop-zone"
            onDragOver={event => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={event => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length) void addPhotos(event.dataTransfer.files); }}
            className={cn('space-y-3 rounded-xl border border-dashed p-4 transition-colors', dragging ? 'border-foreground bg-muted' : 'border-border')}
        >
            <p className="text-sm font-medium text-foreground">Paste a product link or drop photos</p>
            <form onSubmit={event => { event.preventDefault(); void addLink(link); }} className="flex gap-2">
                <Input type="url" value={link} onChange={event => { setLink(event.target.value); setLinkError(null); }} onPaste={onPasteLink}
                    placeholder="https://your-store.com/product" aria-label="Product link" className="h-10 min-w-0" disabled={busy !== null} />
                <Button type="submit" disabled={!link.trim() || busy !== null} className="shrink-0">
                    {busy === 'link' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Add
                </Button>
                <Button type="button" variant="outline" disabled={busy !== null} onClick={() => inputRef.current?.click()} className="shrink-0">
                    {busy === 'photos' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ImagePlus className="mr-2 h-4 w-4" />}Photos
                </Button>
            </form>
            {linkError && <p role="alert" className="text-xs text-destructive">{linkError}</p>}
            {isEmpty && <p className="text-xs text-muted-foreground">You can skip this. Olmo will ask about your product in chat.</p>}
            <input ref={inputRef} type="file" multiple accept="image/jpeg,image/png,image/webp" className="hidden" aria-label="Upload product photos"
                onChange={event => { const files = event.target.files; if (files?.length) void addPhotos(files); event.target.value = ''; }} />
        </div>
        {isPending ? <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div> :
            isError ? <div className="py-10 text-center text-sm text-muted-foreground">Could not load products. <Button variant="link" onClick={() => void refetch()}>Retry</Button></div> :
                products.length === 0 && !busy ? (search.trim() ? <p className="py-10 text-center text-sm text-muted-foreground">No products match your search.</p> : null) :
                    <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3">
                        {busy && <div className="min-w-0" aria-live="polite">
                            <div className="flex aspect-square items-center justify-center rounded-xl border border-border bg-muted"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                            <span className="mt-2 block text-sm text-muted-foreground">Adding…</span>
                        </div>}
                        {products.map(product => <ProductCard
                            key={product.id}
                            product={product}
                            selected={selected?.kind === 'product' && selected.id === product.id}
                            renaming={renamingId === product.id}
                            renameValue={renameValue}
                            onRenameChange={setRenameValue}
                            onRenameCommit={() => void commitRename(product)}
                            onRenameCancel={() => { setRenameValue(product.name); setRenamingId(null); }}
                            onStartRename={() => { setRenameValue(product.name); setRenamingId(product.id); }}
                            onDelete={() => removeProduct(product)}
                            onUse={() => { selectedIdRef.current = product.id; onSelect(productSelection(product)); }}
                        />)}
                    </div>}
        {hasNextPage && <div className="flex justify-center"><Button variant="outline" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>{isFetchingNextPage ? 'Loading…' : 'Load more products'}</Button></div>}
    </div>;
}

function ProductCard({ product, selected, renaming, renameValue, onRenameChange, onRenameCommit, onRenameCancel, onStartRename, onDelete, onUse }: {
    product: ProductRecord; selected: boolean; renaming: boolean; renameValue: string;
    onRenameChange: (value: string) => void; onRenameCommit: () => void; onRenameCancel: () => void;
    onStartRename: () => void; onDelete: () => void; onUse: () => void;
}) {
    const main = product.images[0];
    const pending = product.namingStatus === 'pending';
    const label = pending ? 'Naming…' : product.name;
    return <div className="group min-w-0">
        <button type="button" aria-pressed={selected} aria-label={`Use ${product.name}`} onClick={onUse}
            className="block w-full rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <div className={cn('relative aspect-square overflow-hidden rounded-xl border bg-muted transition-colors group-hover:border-foreground/50', selected ? 'border-foreground ring-2 ring-foreground/20' : 'border-border')}>
                {main && <FileThumbnail fileId={main.fileId} alt={product.name} />}
                {selected && <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-background"><Check className="h-3.5 w-3.5" /></span>}
            </div>
        </button>
        <div className="mt-2 flex min-w-0 items-center gap-1">
            {renaming
                ? <Input autoFocus value={renameValue} maxLength={120} aria-label="Product name" className="h-8"
                    onChange={event => onRenameChange(event.target.value)} onBlur={onRenameCommit}
                    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onRenameCommit(); } if (event.key === 'Escape') onRenameCancel(); }} />
                : <span className={cn('min-w-0 flex-1 truncate text-sm font-semibold', pending ? 'text-muted-foreground' : 'text-foreground')} title={label}>{label}</span>}
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={`More options for ${product.name}`}><MoreHorizontal className="h-4 w-4" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={onStartRename}>Rename</DropdownMenuItem>
                    <DropdownMenuItem onSelect={onDelete} className="text-destructive">Delete</DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    </div>;
}
```

- [ ] **Step 6: Run the panel tests**

Run: `cd apps/web && npx vitest run components/platform/chat/creative-library/ProductsPanel.test.tsx`
Expected: PASS, 10 tests.

If the two menu tests can't find `menuitem`, check that `@/components/ui/dropdown-menu` renders through a Radix Portal. Testing Library's `screen` still finds portal content, so a failure there usually means the pointer-capture polyfill above did not apply: move it into a `beforeAll`.

- [ ] **Step 7: Switch `CreativeLibrary.tsx` to the new panel**

Re-read the file first; the other session may have changed it. Then make only these edits:
1. Delete the `function ProductsPanel(...) { ... }` block and the `storeCreativeImage` function.
2. Delete the `const PRODUCT_PREFIX = 'creative-products/';` line, and the `import { ProductImportCard } from './creative-library/ProductImportCard';` line.
3. Add these imports:

```ts
import { ProductsPanel } from './creative-library/ProductsPanel';
import { storeCreativeImage } from './creative-library/storeCreativeImage';
```

4. Remove any import that is now unused (`ImportedProductData`, `ProductSelection`, `useInfiniteQuery`, `FileRecord` and so on). `tsc` in Step 9 lists them.

The `{tab === 'products' && <ProductsPanel selected={brief.product} onSelect={onSelect} />}` line stays exactly as it is.

- [ ] **Step 8: Remove the old product tests and component**

In `CreativeLibrary.test.tsx`, delete these `it(...)` cases (the new panel test covers the behaviour):
- `imports product data server-side and attaches it to the brief`
- `falls back to a link-only selection and a toast when import fails`
- `does not fire a second import when the form is submitted again while one is in flight`
- `renders the editable import card for an imported selection and forwards edits`
- `does not render the import card for a link-only selection`
- `skips a second import when re-submitting the same already-imported URL`
- `attaches an existing uploaded product image when selected`
- `stores an uploaded product image through the existing file service`
- `does not select a product in a later draft when its upload finishes after leaving Products`

Delete `creative-library/ProductImportCard.tsx`, and `ProductImportCard.test.tsx` if it exists.

Run: `git grep -n "ProductImportCard" -- apps/web`
Expected: no output.

- [ ] **Step 9: Type-check and run the web chat tests**

Run: `cd apps/web && npx tsc --noEmit -p . && npx vitest run components/platform/chat/`
Expected: tsc exits 0, and all tests in that folder pass.

- [ ] **Step 10: Commit**

```bash
git add apps/web/components/platform/chat/creative-library/productsApi.ts apps/web/components/platform/chat/creative-library/storeCreativeImage.ts apps/web/components/platform/chat/creative-library/ProductsPanel.tsx apps/web/components/platform/chat/creative-library/ProductsPanel.test.tsx apps/web/components/platform/chat/CreativeLibrary.tsx apps/web/components/platform/chat/CreativeLibrary.test.tsx
git rm apps/web/components/platform/chat/creative-library/ProductImportCard.tsx
git commit -m "feat(web): products panel with link or photo drop, AI naming, rename and delete"
```

---

### Task 8: Olmo product confirmation block

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/agents/platformAgent.ts` (add a const next to `BRIEF_SELECTIONS_CONTRACT`, and add it to the composition line)
- Test: `apps/agent-orchestrator/src/mastra/agents/__tests__/productConfirmationContract.test.ts`

**Interfaces:**
- Consumes: the brief text format from Task 6 (`- Product: …`, and the unknown-name line).
- Produces: a new instructions section headed exactly `## Product confirmation — required behaviour`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/agent-orchestrator/src/mastra/agents/__tests__/productConfirmationContract.test.ts
import { describe, it, expect } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { platformAgent } from '../platformAgent.js'

async function instructions(): Promise<string> {
  const requestContext = new RequestContext()
  requestContext.set('agentSystemPrompt', 'Base override text.')
  const value = await platformAgent.getInstructions({ requestContext })
  return typeof value === 'string' ? value : JSON.stringify(value)
}

describe('product confirmation contract', () => {
  it('asks for a one-line product check before the first paid generation', async () => {
    const text = await instructions()
    expect(text).toContain('## Product confirmation — required behaviour')
    expect(text).toContain('confirm it in ONE short line before the first paid generation')
    expect(text).toContain('name not known yet')
    expect(text).toContain('Never re-ask anything the brief already states.')
  })

  it('comes before the product-photo reuse contract and leaves it unchanged', async () => {
    const text = await instructions()
    const confirmation = text.indexOf('## Product confirmation — required behaviour')
    const reuse = text.indexOf('## Product-photo reuse — required behaviour')
    expect(confirmation).toBeGreaterThan(-1)
    expect(confirmation).toBeLessThan(reuse)
    expect(text).toContain('Before asking for a product photo in any contract below that needs one')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/agents/__tests__/productConfirmationContract.test.ts`
Expected: FAIL. `toContain('## Product confirmation — required behaviour')` fails.

- [ ] **Step 3: Add the block**

In `platformAgent.ts`, directly after the `BRIEF_SELECTIONS_CONTRACT` constant (it ends at `...without rewriting or paraphrasing either.\``), add:

```ts
    const PRODUCT_CONFIRMATION_CONTRACT = `\n\n## Product confirmation — required behaviour
When the creative brief includes a "- Product:" line, confirm it in ONE short line before the first paid generation for that ad — for example: "I'll make this for The Ordinary Niacinamide serum, a blemish serum, ₹590. Right?" Fold it into your cost plan message rather than sending a separate message, and treat the user's approval of the plan as confirming the product.
- Ask only about what is missing or conflicting. Never re-ask anything the brief already states.
- If the product line says "name not known yet", ask the user what the product is before planning.
- If the user's message attaches an image that clearly shows a different product from the selected one, ask which one to use. Never guess.
- This check happens before the Product-photo reuse contract below; it does not replace it.`
```

In the composition line (`+ BRIEF_SELECTIONS_CONTRACT + COST_CONFIRMATION_CONTRACT + ...`), change `BRIEF_SELECTIONS_CONTRACT + COST_CONFIRMATION_CONTRACT` to:

```ts
BRIEF_SELECTIONS_CONTRACT + PRODUCT_CONFIRMATION_CONTRACT + COST_CONFIRMATION_CONTRACT
```

Change no other text in the file.

- [ ] **Step 4: Run the contract tests and the agent suite**

Run: `cd apps/agent-orchestrator && npx vitest run src/mastra/agents/`
Expected: PASS, all, including the existing `platformAgent.test.ts` and `ugcCharacterContract.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/agents/platformAgent.ts apps/agent-orchestrator/src/mastra/agents/__tests__/productConfirmationContract.test.ts
git commit -m "feat(orchestrator): Olmo confirms the brief's product in one line"
```

---

### Task 9: Backfill existing product images

**Files:**
- Create: `products/agent-platform/packages/api/scripts/backfill-creative-products.ts`
- Modify: `products/agent-platform/packages/api/package.json` (the `scripts` entry)
- Test: `products/agent-platform/packages/api/__tests__/backfillCreativeProducts.test.ts`

**Interfaces:**
- Consumes: `createProduct`, `PRODUCT_NAME_PLACEHOLDER` and `ALLOWED_PRODUCT_IMAGE_TYPES` from `lib/productRecords.ts`, and `nameProduct` from `lib/productNaming.ts`.
- Produces: `selectBackfillCandidates(files: Array<{ id: string; tenantId: string; uploadedBy: string | null; mimeType: string | null }>, referencedIds: Set<string>)`, which returns the same array type, filtered. It also produces the script `pnpm --filter <api package> backfill:creative-products`.

- [ ] **Step 1: Write the failing test**

```ts
// products/agent-platform/packages/api/__tests__/backfillCreativeProducts.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));
vi.mock('@serverless-saas/storage', () => ({ storageService: {} }));

import { selectBackfillCandidates } from '../scripts/backfill-creative-products';

describe('selectBackfillCandidates', () => {
  it('keeps unreferenced image files and skips referenced or non-image ones', () => {
    const files = [
      { id: 'a', tenantId: 't1', uploadedBy: null, mimeType: 'image/png' },
      { id: 'b', tenantId: 't1', uploadedBy: null, mimeType: 'image/jpeg' },
      { id: 'c', tenantId: 't1', uploadedBy: null, mimeType: 'application/pdf' },
      { id: 'd', tenantId: 't2', uploadedBy: 'u1', mimeType: 'image/webp' },
    ];
    expect(selectBackfillCandidates(files, new Set(['b'])).map(f => f.id)).toEqual(['a', 'd']);
  });
});
```

The vitest config only includes `__tests__/**` and `seeds/**`, which is why the test lives here even though it imports from `scripts/`.

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run __tests__/backfillCreativeProducts.test.ts`
Expected: FAIL, "Cannot find module '../scripts/backfill-creative-products'".

- [ ] **Step 3: Write the script**

```ts
// products/agent-platform/packages/api/scripts/backfill-creative-products.ts
// One-off: turns loose images under creative-products/ into creative_products
// rows (one product per file), AI-named. Idempotent — files already referenced
// by a product are skipped. Needs DATABASE_URL, AWS credentials for S3,
// AGENT_ORCHESTRATOR_URL and INTERNAL_SERVICE_KEY.
//   pnpm backfill:creative-products
import { and, isNull, like } from 'drizzle-orm';
import { db } from '../db';
import { files } from '@serverless-saas/database/schema/storage';
import { creativeProducts } from '@serverless-saas/agent-schema/creativeProducts';
import { ALLOWED_PRODUCT_IMAGE_TYPES, PRODUCT_NAME_PLACEHOLDER, createProduct } from '../lib/productRecords';
import { nameProduct } from '../lib/productNaming';

type CandidateFile = { id: string; tenantId: string; uploadedBy: string | null; mimeType: string | null };

export function selectBackfillCandidates(rows: CandidateFile[], referencedIds: Set<string>): CandidateFile[] {
  return rows.filter((row) => !referencedIds.has(row.id) && ALLOWED_PRODUCT_IMAGE_TYPES.has(row.mimeType ?? ''));
}

async function main(): Promise<void> {
  const rows = await db
    .select({ id: files.id, tenantId: files.tenantId, uploadedBy: files.uploadedBy, mimeType: files.mimeType })
    .from(files)
    .where(and(like(files.key, 'creative-products/%'), isNull(files.deletedAt)));
  const products = await db.select({ imageFileIds: creativeProducts.imageFileIds }).from(creativeProducts);
  const referenced = new Set(products.flatMap((p) => p.imageFileIds));
  const candidates = selectBackfillCandidates(rows, referenced);
  console.log(`[backfill] ${rows.length} files under creative-products/, ${candidates.length} to convert`);

  for (const file of candidates) {
    const product = await createProduct({
      tenantId: file.tenantId, createdBy: file.uploadedBy, name: PRODUCT_NAME_PLACEHOLDER, description: null,
      price: null, sourceUrl: null, imageFileIds: [file.id], namingStatus: 'pending',
    });
    const named = await nameProduct(file.tenantId, product.id);
    console.log(`[backfill] file=${file.id} -> product=${product.id} name="${named?.name}" status=${named?.namingStatus}`);
  }
}

// Run only when executed directly, so the test can import selectBackfillCandidates.
if (process.argv[1]?.includes('backfill-creative-products')) {
  main().then(() => process.exit(0)).catch((error) => { console.error('[backfill] failed', error); process.exit(1); });
}
```

- [ ] **Step 4: Add the package script**

In `products/agent-platform/packages/api/package.json`, inside `"scripts"`, add after the `db:seed:creative-library-assets` line (add a trailing comma to that line):

```json
    "backfill:creative-products": "tsx scripts/backfill-creative-products.ts"
```

- [ ] **Step 5: Run the test and the whole API package**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run && pnpm type-check`
Expected: all pass, and type-check exits 0.

If `tsc` complains that `scripts/` sits outside `rootDir` or `include`: `scripts/migrate-provider-keys.ts` already lives there, so match whatever that file does, or add `scripts` to the `exclude` list in `tsconfig.json` if that's where the existing script is excluded.

- [ ] **Step 6: Commit**

```bash
git add products/agent-platform/packages/api/scripts/backfill-creative-products.ts products/agent-platform/packages/api/package.json products/agent-platform/packages/api/__tests__/backfillCreativeProducts.test.ts
git commit -m "feat(api): one-off backfill of loose product images into products"
```

---

### Task 10: Whole-repo verification (no deploy)

Deploying needs the user's go-ahead. This task only proves the branch is green and lists the deploy steps.

- [ ] **Step 1: Run every affected suite and type-check**

```bash
pnpm --filter @serverless-saas/agent-schema build
cd products/agent-platform/packages/api && pnpm type-check && pnpm exec vitest run && cd -
cd apps/agent-orchestrator && npx tsc --noEmit -p . && npx vitest run && cd -
cd apps/web && npx tsc --noEmit -p . && npx vitest run components/platform/chat/ && cd -
```

Expected: every command exits 0. Report the pass counts.

- [ ] **Step 2: Confirm no stray references remain**

Run: `git grep -n "ProductImportCard\|PRODUCT_PREFIX = 'creative-products/'" -- apps/web`
Expected: exactly one hit, the `PRODUCT_PREFIX` constant in `ProductsPanel.tsx`.

- [ ] **Step 3: Write down the deploy steps for the user (do not run them)**

1. Apply the migration: `cd packages/foundation/database && pnpm exec drizzle-kit migrate`, against the dev `DATABASE_URL`.
2. `sam build --config-file samconfig.dev.toml && sam deploy --config-file samconfig.dev.toml`, from the main checkout, never a worktree.
3. On the VM: pull, rebuild the orchestrator, and `pm2 restart` it (`./deploy.sh` does not). Then run `./deploy.sh` for the web app.
4. Run the backfill on the VM, where `AGENT_ORCHESTRATOR_URL=http://localhost:3001` resolves: `pnpm --filter <api package name> backfill:creative-products`.
5. Live check: drop a photo in the Products tab, and see it become a card that names itself within a few seconds. Paste a Shopify product link. Send a brief, and check Olmo's reply contains the one-line product check.
