# Drive Products View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Drive → Products the product library itself (one card per named product, same data as the composer), name product photo files after their product, and send the photos of deleted products and imported products to the right Drive views.

**Architecture:**
- **API:** new helpers in `productRecords.ts` rename photo files whenever a product's final name is set. A new read route lists every image file id that a product uses, so Drive can tell which files are orphaned.
- **Web:** `ProductsPanel` gets three optional props (open instead of select, hide the heading, custom empty hint), so a new `DriveProducts` view can reuse it whole. `FilesList`, `systemFolders` and the Drive page get a few lines each, because another session is actively editing them.

**Tech Stack:** Drizzle, Hono, Vitest, Next.js, React Query, Testing Library and user-event.

**Spec:** `docs/superpowers/specs/2026-09-27-drive-products-view-design.md`

**Plan-level rulings (deviations from the spec's architecture notes, same UX intent):**
- **The whole `ProductsPanel` is reused through props.** The spec suggested moving `ProductCard` into its own file and extracting a creation hook. Reusing the panel as it is gives Drive every product behaviour (drop, link, AI naming, rename, delete with undo, stale-naming retry) with no copy and far less refactoring. The cost if this is wrong: a later split still needs doing.
- **"Add to chat" and "Download photos" are on the product's opened view, not in the card's ⋯ menu.** `AddToChatMenu` is a popover, and a popover nested inside a Radix dropdown item is fragile. So the card's ⋯ stays as Rename and Delete in both places, and clicking the card opens the product with those two actions at the top. The cost if this is wrong: one extra click.

## Global Constraints

- Every DB query filters by `tenant_id`.
- Only `files.name` (the display name) is changed. `files.key` and S3 are never touched.
- Photo file name format: `${productName}${i === 0 ? '' : ` (${i + 1})`}${ext}`, capped at 255 characters (`files.name` is varchar(255)). The product name is shortened first; the suffix and extension are kept. `/` and `\` in the product name become `-`.
- Extension: taken from the file's current name (`/\.[A-Za-z0-9]{1,5}$/`, lowercased). Otherwise it comes from the mime type: `image/jpeg` → `.jpg`, `image/png` → `.png`, `image/webp` → `.webp`.
- Files are renamed when the final name is set: by `renameProduct`, by `applyNamingResult` (only when it actually applied a non-null result), and by `createProduct` (only when `namingStatus === 'done'`). They are never renamed for the placeholder `Untitled product`.
- A failed file rename is logged and swallowed. The product operation still succeeds.
- Product storage prefixes are `creative-products/` and `imported-products/`. `imported-products` is hidden at the Drive root and has no pill.
- Uploads shows a product-prefix file only when no product references it. While the list of referenced ids is still loading, no product-prefix file is shown in Uploads.
- Tests in `products/agent-platform/packages/api` live in `__tests__/`.
- Keep edits to `apps/web/components/platform/files/FilesList.tsx`, `systemFolders.ts` and `apps/web/app/[tenant]/dashboard/drive/page.tsx` to exactly what each task lists. Another session edits Drive. Rebase on `main` before merging.
- Lambdas are built and deployed from the main checkout only.

## Review Focus

1. **A product name containing `/` or longer than 255 characters.** The file name must stay valid and within 255 characters, with the extension kept. Pinned in Task 1.
2. **A user renames while AI naming is still pending.** Files are renamed only when `applyNamingResult` actually applied a name, never after the user's rename has won. Pinned in Task 1.
3. **The file rename throws** (DB error). The product rename or create must still succeed. Pinned in Task 1.
4. **Another tenant's file id** in `renameProductFiles` or in the image-ids route. It must never be touched or returned. Pinned in Tasks 1 and 2.
5. **Uploads while the referenced-id list is still loading.** Product files must not flash into Uploads. Pinned in Task 5.

---

### Task 1: File naming helpers and wiring (API lib)

**Files:**
- Modify: `products/agent-platform/packages/api/lib/productRecords.ts`
- Modify: `products/agent-platform/packages/api/__tests__/productRecords.test.ts`

**Interfaces — Produces:**
- `productFileName(productName: string, index: number, currentName: string, mimeType: string | null): string`
- `renameProductFiles(tenantId: string, imageFileIds: string[], productName: string): Promise<void>`: throws on DB error.
- `listProductImageFileIds(tenantId: string): Promise<string[]>`: unique ids across the tenant's products.
- `createProduct`, `renameProduct` and `applyNamingResult` keep their signatures and now rename files as described in the Global Constraints.

- [ ] **Step 1: Write failing tests**

Append to `__tests__/productRecords.test.ts`, and add `productFileName` to the import from `../lib/productRecords`:

```ts
describe('productFileName', () => {
  it('names the main photo after the product and numbers the rest, keeping each extension', () => {
    expect(productFileName('Campus Shoes', 0, 'IMG_1.JPG', 'image/jpeg')).toBe('Campus Shoes.jpg');
    expect(productFileName('Campus Shoes', 1, 'shot.png', 'image/png')).toBe('Campus Shoes (2).png');
  });

  it('falls back to an extension from the mime type when the current name has none', () => {
    expect(productFileName('Serum', 0, 'f5c10d58-8c5c', 'image/webp')).toBe('Serum.webp');
    expect(productFileName('Serum', 0, 'noext', null)).toBe('Serum');
  });

  it('replaces slashes and caps the name at 255 characters, keeping suffix and extension', () => {
    const name = productFileName(`a/b\\${'x'.repeat(400)}`, 2, 'p.jpg', 'image/jpeg');
    expect(name.length).toBeLessThanOrEqual(255);
    expect(name.startsWith('a-b-')).toBe(true);
    expect(name.endsWith(' (3).jpg')).toBe(true);
  });
});

describe('renameProductFiles', () => {
  it('renames each of the tenant\'s files in image order and skips unchanged or missing ones', async () => {
    vi.resetModules();
    const updates: Array<{ set: unknown; where: unknown }> = [];
    const selectWhere = vi.fn().mockResolvedValue([
      { id: 'f2', name: 'b.png', mimeType: 'image/png' },
      { id: 'f1', name: 'Serum.jpg', mimeType: 'image/jpeg' },
    ]);
    vi.doMock('../db', () => ({ db: {
      select: vi.fn(() => ({ from: () => ({ where: selectWhere }) })),
      update: vi.fn(() => ({ set: (set: unknown) => ({ where: (where: unknown) => { updates.push({ set, where }); return Promise.resolve(); } }) })),
    } }));
    const { renameProductFiles } = await import('../lib/productRecords');

    await renameProductFiles('t1', ['f1', 'f2', 'f3'], 'Serum');

    // f1 already has the right name, f3 isn't the tenant's (not returned), so only f2 changes.
    expect(updates).toHaveLength(1);
    expect(updates[0].set).toEqual(expect.objectContaining({ name: 'Serum (2).png' }));
    const whereSql = new PgDialect().sqlToQuery(updates[0].where as never).sql;
    expect(whereSql).toContain('"tenant_id" = $');
  });
});

describe('name wiring', () => {
  function mockDb(opts: { returningRow?: Record<string, unknown> | null; failFileSelect?: boolean }) {
    const fileUpdates: unknown[] = [];
    const productRow = opts.returningRow;
    let selectCalls = 0; // only the first select (the file lookup for renaming) fails
    return {
      fileUpdates,
      db: {
        insert: vi.fn(() => ({ values: () => ({ returning: () => Promise.resolve([productRow]) }) })),
        update: vi.fn(() => ({
          set: (set: Record<string, unknown>) => ({
            where: () => {
              if ('namingStatus' in set || 'description' in set) {
                return { returning: () => Promise.resolve(productRow ? [productRow] : []) };
              }
              fileUpdates.push(set);
              return Promise.resolve();
            },
          }),
        })),
        select: vi.fn(() => ({ from: () => ({ where: () => (opts.failFileSelect && selectCalls++ === 0)
          ? Promise.reject(new Error('db down'))
          : Promise.resolve([{ id: 'f1', name: 'x.png', mimeType: 'image/png', size: 3 }]) }) })),
      },
    };
  }
  const row = { id: 'p1', tenantId: 't1', name: 'Serum', description: null, price: null, sourceUrl: null, imageFileIds: ['f1'], namingStatus: 'done', createdBy: null, createdAt: new Date(0), updatedAt: new Date(0) };

  it('renameProduct renames the photo files to the new name', async () => {
    vi.resetModules();
    const m = mockDb({ returningRow: row });
    vi.doMock('../db', () => ({ db: m.db }));
    const { renameProduct } = await import('../lib/productRecords');
    await renameProduct('t1', 'p1', 'Serum');
    expect(m.fileUpdates).toEqual([expect.objectContaining({ name: 'Serum.png' })]);
  });

  it('renameProduct still succeeds when renaming the files fails', async () => {
    vi.resetModules();
    const m = mockDb({ returningRow: row, failFileSelect: true });
    vi.doMock('../db', () => ({ db: m.db }));
    const { renameProduct } = await import('../lib/productRecords');
    await expect(renameProduct('t1', 'p1', 'Serum')).resolves.not.toBeNull();
  });

  it('applyNamingResult renames files only when it actually applied a name', async () => {
    vi.resetModules();
    const applied = mockDb({ returningRow: row });
    vi.doMock('../db', () => ({ db: applied.db }));
    let mod = await import('../lib/productRecords');
    await mod.applyNamingResult('t1', 'p1', { name: 'Serum', description: null });
    expect(applied.fileUpdates).toHaveLength(1);

    vi.resetModules();
    const notPending = mockDb({ returningRow: null });
    vi.doMock('../db', () => ({ db: notPending.db }));
    mod = await import('../lib/productRecords');
    await mod.applyNamingResult('t1', 'p1', { name: 'Serum', description: null });
    await mod.applyNamingResult('t1', 'p1', null);
    expect(notPending.fileUpdates).toHaveLength(0);
  });

  it('createProduct renames files only for an already-named product', async () => {
    vi.resetModules();
    const named = mockDb({ returningRow: row });
    vi.doMock('../db', () => ({ db: named.db }));
    let mod = await import('../lib/productRecords');
    await mod.createProduct({ tenantId: 't1', createdBy: null, name: 'Serum', description: null, price: null, sourceUrl: null, imageFileIds: ['f1'], namingStatus: 'done' });
    expect(named.fileUpdates).toHaveLength(1);

    vi.resetModules();
    const pending = mockDb({ returningRow: { ...row, name: 'Untitled product', namingStatus: 'pending' } });
    vi.doMock('../db', () => ({ db: pending.db }));
    mod = await import('../lib/productRecords');
    await mod.createProduct({ tenantId: 't1', createdBy: null, name: 'Untitled product', description: null, price: null, sourceUrl: null, imageFileIds: ['f1'], namingStatus: 'pending' });
    expect(pending.fileUpdates).toHaveLength(0);
  });
});
```

**Update the existing test "only updates a product that is still pending, so a user rename wins".** `applyNamingResult` now calls `.returning(...)`, so its `where` mock must return `{ returning: vi.fn().mockResolvedValue([]) }` instead of a resolved promise. Keep its assertions: the WHERE has the `naming_status` guard, and `set` gets the name and `namingStatus: 'done'`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run __tests__/productRecords.test.ts`
Expected: FAIL. `productFileName` and `renameProductFiles` aren't exported, and the wiring tests fail.

- [ ] **Step 3: Implement in `lib/productRecords.ts`**

Add after `dropImageless`:

```ts
const EXT_BY_MIME: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MAX_FILE_NAME = 255; // files.name is varchar(255)

/** Display name for a product's photo: "<product>.<ext>", then "<product> (2).<ext>"… */
export function productFileName(productName: string, index: number, currentName: string, mimeType: string | null): string {
  const match = /\.[A-Za-z0-9]{1,5}$/.exec(currentName);
  const ext = match ? match[0].toLowerCase() : (EXT_BY_MIME[mimeType ?? ''] ?? '');
  const suffix = index === 0 ? '' : ` (${index + 1})`;
  const base = productName.trim().replace(/[/\\]/g, '-');
  return `${base.slice(0, MAX_FILE_NAME - suffix.length - ext.length).trimEnd()}${suffix}${ext}`;
}

/** Renames the product's photo files (display name only — never the S3 key) so
 *  the # picker, attachments, Drive and downloads show the product's name. */
export async function renameProductFiles(tenantId: string, imageFileIds: string[], productName: string): Promise<void> {
  if (imageFileIds.length === 0) return;
  const rows = await db
    .select({ id: files.id, name: files.name, mimeType: files.mimeType })
    .from(files)
    .where(and(eq(files.tenantId, tenantId), inArray(files.id, imageFileIds), isNull(files.deletedAt)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  await Promise.all(imageFileIds.map((id, index) => {
    const file = byId.get(id);
    if (!file) return undefined;
    const name = productFileName(productName, index, file.name, file.mimeType);
    if (name === file.name) return undefined;
    return db.update(files).set({ name, updatedAt: new Date() }).where(and(eq(files.tenantId, tenantId), eq(files.id, id)));
  }));
}

/** The product name is the source of truth; a failed file rename is logged, never fatal. */
async function syncProductFileNames(tenantId: string, imageFileIds: string[], productName: string): Promise<void> {
  try {
    await renameProductFiles(tenantId, imageFileIds, productName);
  } catch (error) {
    console.error('[productRecords] renaming product files failed', { tenantId, error: (error as Error).message });
  }
}

export async function listProductImageFileIds(tenantId: string): Promise<string[]> {
  const rows = await db
    .select({ imageFileIds: creativeProducts.imageFileIds })
    .from(creativeProducts)
    .where(eq(creativeProducts.tenantId, tenantId));
  return [...new Set(rows.flatMap((r) => r.imageFileIds))];
}
```

Wire it in:
- **`createProduct`:** after the insert, `if (row.namingStatus === 'done') await syncProductFileNames(input.tenantId, row.imageFileIds, row.name);`. Do this before `loadProductImages`, so the returned images carry the new names.
- **`renameProduct`:** after the `if (!row) return null;` line, `await syncProductFileNames(tenantId, row.imageFileIds, row.name);`. Do this before loading the images.
- **`applyNamingResult`:** add `.returning({ imageFileIds: creativeProducts.imageFileIds, name: creativeProducts.name })` to the update. Then `if (result && updated) await syncProductFileNames(tenantId, updated.imageFileIds, updated.name);`, where `const [updated] = await db.update(...)...returning(...)`.

- [ ] **Step 4: Run the tests, type-check, and run the suite**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run __tests__/productRecords.test.ts && pnpm type-check && pnpm exec vitest run`
Expected: the file passes, and type-check exits 0. The only failure in the suite is the known `personas.test.ts` one.

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/api/lib/productRecords.ts products/agent-platform/packages/api/__tests__/productRecords.test.ts
git commit -m "feat(api): name product photo files after their product"
```

---

### Task 2: Image-ids route and the one-off rename script (API)

**Files:**
- Modify: `products/agent-platform/packages/api/routes/products.ts`
- Modify: `products/agent-platform/packages/api/__tests__/products.routes.test.ts`
- Create: `products/agent-platform/packages/api/scripts/rename-product-files.ts`
- Modify: `products/agent-platform/packages/api/package.json`

**Interfaces:**
- Consumes: `listProductImageFileIds` and `renameProductFiles` (Task 1).
- Produces:
  - `GET /products/image-file-ids`, which returns `{ data: string[] }` and needs `files`/`read`.
  - The script `rename-product-files`, which exports `productsToRename(rows)` for tests.

- [ ] **Step 1: Write failing tests**

In `__tests__/products.routes.test.ts`, add `listProductImageFileIds: vi.fn()` to the `lib` object, add the matching passthrough in the `vi.mock('../lib/productRecords', …)` factory, and add:

```ts
  it('lists the tenant\'s product image file ids', async () => {
    lib.listProductImageFileIds.mockResolvedValue([F1, F2]);
    const res = await (await app()).request('/products/image-file-ids');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([F1, F2]);
    expect(lib.listProductImageFileIds).toHaveBeenCalledWith('tenant-1');
  });

  it('requires files:read for image file ids', async () => {
    const res = await (await app([{ resource: 'files', action: 'create' }])).request('/products/image-file-ids');
    expect(res.status).toBe(403);
  });
```

Create `__tests__/renameProductFiles.script.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import { productsToRename } from '../scripts/rename-product-files';

describe('productsToRename', () => {
  it('keeps only named products with images', () => {
    const rows = [
      { id: 'a', tenantId: 't', name: 'Serum', imageFileIds: ['f1'], namingStatus: 'done' as const },
      { id: 'b', tenantId: 't', name: 'Untitled product', imageFileIds: ['f2'], namingStatus: 'pending' as const },
      { id: 'c', tenantId: 't', name: 'X', imageFileIds: [], namingStatus: 'done' as const },
      { id: 'd', tenantId: 't', name: 'Untitled product', imageFileIds: ['f3'], namingStatus: 'failed' as const },
    ];
    expect(productsToRename(rows).map(r => r.id)).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run __tests__/products.routes.test.ts __tests__/renameProductFiles.script.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `routes/products.ts`, add `listProductImageFileIds` to the import, and add this before `productsRoutes.post('/', …)`:

```ts
// Every image file a product uses — Drive's Uploads view needs it to show a
// product photo there only once no product references it anymore.
productsRoutes.get('/image-file-ids', async (c) => {
  const g = guard(c, 'read');
  if (g instanceof Response) return g;
  return c.json({ data: await listProductImageFileIds(g.tenantId) });
});
```

Create `scripts/rename-product-files.ts`:

```ts
// One-off: rename the photo files of already-named products after the product
// (display name only). Idempotent — unchanged names are skipped. Needs only
// DATABASE_URL. Run from the laptop:  pnpm rename:product-files
import { db } from '../db';
import { creativeProducts } from '@serverless-saas/agent-schema/creativeProducts';
import { renameProductFiles } from '../lib/productRecords';

type Row = { id: string; tenantId: string; name: string; imageFileIds: string[]; namingStatus: 'pending' | 'done' | 'failed' };

export function productsToRename(rows: Row[]): Row[] {
  return rows.filter((r) => r.namingStatus === 'done' && r.imageFileIds.length > 0);
}

async function main(): Promise<void> {
  const rows = await db.select({
    id: creativeProducts.id, tenantId: creativeProducts.tenantId, name: creativeProducts.name,
    imageFileIds: creativeProducts.imageFileIds, namingStatus: creativeProducts.namingStatus,
  }).from(creativeProducts);
  const todo = productsToRename(rows);
  console.log(`[rename-files] ${rows.length} products, ${todo.length} to rename`);
  for (const r of todo) {
    await renameProductFiles(r.tenantId, r.imageFileIds, r.name);
    console.log(`[rename-files] product=${r.id} "${r.name}" files=${r.imageFileIds.length}`);
  }
}

if (process.argv[1]?.includes('rename-product-files')) {
  main().then(() => process.exit(0)).catch((error) => { console.error('[rename-files] failed', error); process.exit(1); });
}
```

In `package.json` `scripts`, after `backfill:creative-products`, add `"rename:product-files": "tsx scripts/rename-product-files.ts"`, with a comma on the previous line.

- [ ] **Step 4: Run the tests, type-check, and run the suite**

Run: `cd products/agent-platform/packages/api && pnpm exec vitest run __tests__/products.routes.test.ts __tests__/renameProductFiles.script.test.ts && pnpm type-check && pnpm exec vitest run`
Expected: pass. The only failure is the known personas one.

- [ ] **Step 5: Commit**

```bash
git add products/agent-platform/packages/api/routes/products.ts products/agent-platform/packages/api/__tests__/products.routes.test.ts products/agent-platform/packages/api/scripts/rename-product-files.ts products/agent-platform/packages/api/__tests__/renameProductFiles.script.test.ts products/agent-platform/packages/api/package.json
git commit -m "feat(api): product image-ids route and one-off photo rename script"
```

---

### Task 3: ProductsPanel reuse props (web)

**Files:**
- Modify: `apps/web/components/platform/chat/creative-library/ProductsPanel.tsx`
- Modify: `apps/web/components/platform/chat/creative-library/ProductsPanel.test.tsx`

**Interfaces — Produces:** these optional `ProductsPanel` props:
- `onOpen?: (product: ProductRecord) => void`: when set, clicking a card calls it instead of selecting the product, and the card's accessible label becomes `Open ${name}`.
- `hideHeading?: boolean`: hides the "Products" `<h2>`. The search box stays.
- `emptyHint?: string`: replaces the default first-visit line.

The composer's behaviour doesn't change when these are omitted.

- [ ] **Step 1: Write failing tests**

Append to `ProductsPanel.test.tsx`, reusing its `record`, `renderPanel` and mocks:

```tsx
describe('ProductsPanel reuse props', () => {
    it('opens instead of selecting when onOpen is given', async () => {
        vi.mocked(productsApi.listProducts).mockResolvedValue({ data: [record()] });
        const onOpen = vi.fn();
        const onSelect = vi.fn();
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        render(<QueryClientProvider client={client}><ProductsPanel selected={null} onSelect={onSelect} onOpen={onOpen} /></QueryClientProvider>);
        fireEvent.click(await screen.findByRole('button', { name: 'Open Niacinamide serum' }));
        expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('hides the heading and uses a custom empty hint', async () => {
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        render(<QueryClientProvider client={client}><ProductsPanel selected={null} onSelect={vi.fn()} hideHeading emptyHint="Add your first product." /></QueryClientProvider>);
        expect(await screen.findByText('Add your first product.')).toBeTruthy();
        expect(screen.queryByRole('heading', { name: 'Products' })).toBeNull();
        expect(screen.queryByText('You can skip this. Olmo will ask about your product in chat.')).toBeNull();
    });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd apps/web && npx vitest run components/platform/chat/creative-library/ProductsPanel.test.tsx`
Expected: the two new tests fail.

- [ ] **Step 3: Implement**
- Add the three props to the `ProductsPanel` props type, with a JSDoc line each.
- Heading: render `<h2>…Products</h2>` only when `!hideHeading`, and keep the row with the search box.
- Empty hint: `{isEmpty && <p …>{emptyHint ?? 'You can skip this. Olmo will ask about your product in chat.'}</p>}`.
- Pass `useLabel={onOpen ? 'Open' : 'Use'}` to `ProductCard`, and use ``aria-label={`${useLabel} ${product.name}`}``.
- In the card's `onUse` callback, when `onOpen` is set, call `onOpen(product)` and return before the selection logic.

- [ ] **Step 4: Run the tests and type-check**

Run: `cd apps/web && npx vitest run components/platform/chat/creative-library/ && npx tsc --noEmit -p .`
Expected: pass. tsc shows only the 3 known baseline errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/platform/chat/creative-library/ProductsPanel.tsx apps/web/components/platform/chat/creative-library/ProductsPanel.test.tsx
git commit -m "feat(web): ProductsPanel can open products and hide its heading for reuse"
```

---

### Task 4: DriveProducts view (web)

**Files:**
- Create: `apps/web/components/platform/files/DriveProducts.tsx`
- Create: `apps/web/components/platform/files/DriveProducts.test.tsx`
- Modify: `apps/web/components/platform/chat/creative-library/productsApi.ts` (add `listProductImageFileIds`)

**Interfaces:**
- Consumes: the Task 3 props.
- Produces:
  - `DriveProducts({ conversations, canAddToChat, onAddToChat, onDownload })`, where `onAddToChat: (attachments: Attachment[], conversationId: string | null) => void` and `onDownload: (fileId: string) => void`;
  - `listProductImageFileIds(): Promise<string[]>` in productsApi.

- [ ] **Step 1: Write failing tests**

```tsx
// apps/web/components/platform/files/DriveProducts.test.tsx
/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DriveProducts } from './DriveProducts';
import * as productsApi from '@/components/platform/chat/creative-library/productsApi';

vi.mock('@/components/platform/chat/creative-library/productsApi', async (orig) => ({
    ...(await orig<typeof import('@/components/platform/chat/creative-library/productsApi')>()),
    listProducts: vi.fn(),
}));
vi.mock('@/components/platform/files/FileThumbnail', () => ({ FileThumbnail: () => <span /> }));
vi.mock('./components/AddToChatMenu', () => ({
    AddToChatMenu: ({ onPick, label }: { onPick: (id: string | null) => void; label?: string }) =>
        <button type="button" onClick={() => onPick(null)}>{label ?? 'Add to chat'}</button>,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }));

const images = [
    { fileId: 'f1', name: 'Serum.png', type: 'image/png', size: 3 },
    { fileId: 'f2', name: 'Serum (2).png', type: 'image/png', size: 3 },
];
const product = { id: 'p1', name: 'Serum', description: null, price: null, sourceUrl: null, namingStatus: 'done' as const, images, createdAt: '2026-09-27T00:00:00.000Z' };

function renderDrive(props: Partial<Parameters<typeof DriveProducts>[0]> = {}) {
    const onAddToChat = vi.fn();
    const onDownload = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><DriveProducts conversations={[]} canAddToChat onAddToChat={onAddToChat} onDownload={onDownload} {...props} /></QueryClientProvider>);
    return { onAddToChat, onDownload };
}

beforeEach(() => { vi.clearAllMocks(); vi.mocked(productsApi.listProducts).mockResolvedValue({ data: [product] }); });

describe('DriveProducts', () => {
    it('lists products by name, not files', async () => {
        renderDrive();
        expect(await screen.findByText('Serum')).toBeTruthy();
        expect(screen.queryByText('Serum (2).png')).toBeNull();
    });

    it('opens a product to show its photos, adds them all to chat, downloads them, and goes back', async () => {
        const { onAddToChat, onDownload } = renderDrive();
        fireEvent.click(await screen.findByRole('button', { name: 'Open Serum' }));
        expect(screen.getByText('Serum (2).png')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Add photos to chat' }));
        expect(onAddToChat).toHaveBeenCalledWith(images, null);
        fireEvent.click(screen.getByRole('button', { name: /Download photos/ }));
        expect(onDownload.mock.calls.map(c => c[0])).toEqual(['f1', 'f2']);
        fireEvent.click(screen.getByRole('button', { name: /Back to products/ }));
        expect(await screen.findByRole('button', { name: 'Open Serum' })).toBeTruthy();
    });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd apps/web && npx vitest run components/platform/files/DriveProducts.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Add to `productsApi.ts`:

```ts
export async function listProductImageFileIds(): Promise<string[]> {
    return (await api.get<{ data: string[] }>('/api/v1/products/image-file-ids')).data;
}
```

Create `DriveProducts.tsx`:

```tsx
"use client";

import { useState } from 'react';
import { ArrowLeft, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FileThumbnail } from './FileThumbnail';
import { AddToChatMenu } from './components/AddToChatMenu';
import { ProductsPanel } from '@/components/platform/chat/creative-library/ProductsPanel';
import type { ProductRecord } from '@/components/platform/chat/creative-library/productsApi';
import type { Attachment } from '@/types/agent-events';
import type { Conversation } from '@/components/platform/chat/types';

/** Drive's Products tab is the product library itself — the same list, cards,
 *  naming, rename and delete as the composer — not a folder of files. */
export function DriveProducts({ conversations, canAddToChat, onAddToChat, onDownload }: {
    conversations: Conversation[];
    canAddToChat: boolean;
    onAddToChat: (attachments: Attachment[], conversationId: string | null) => void;
    onDownload: (fileId: string) => void;
}) {
    const [open, setOpen] = useState<ProductRecord | null>(null);

    if (open) {
        return <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Button variant="ghost" size="sm" onClick={() => setOpen(null)} aria-label="Back to products">
                    <ArrowLeft className="mr-1 h-4 w-4" />Products
                </Button>
                <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-foreground">{open.name}</h2>
                <AddToChatMenu variant="bulk" label="Add photos to chat" conversations={conversations} disabled={!canAddToChat}
                    onPick={conversationId => onAddToChat(open.images, conversationId)} />
                <Button size="sm" variant="outline" onClick={() => open.images.forEach(image => onDownload(image.fileId))}>
                    <Download className="mr-1 h-4 w-4" />Download photos
                </Button>
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {open.images.map(image => <div key={image.fileId} className="min-w-0">
                    <div className="relative aspect-square overflow-hidden rounded-xl border border-border bg-muted">
                        <FileThumbnail fileId={image.fileId} alt="" />
                    </div>
                    <div className="mt-2 flex items-center gap-1">
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={image.name}>{image.name}</span>
                        <AddToChatMenu variant="icon" conversations={conversations} disabled={!canAddToChat}
                            onPick={conversationId => onAddToChat([image], conversationId)} />
                        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Download ${image.name}`} onClick={() => onDownload(image.fileId)}>
                            <Download className="h-4 w-4" />
                        </Button>
                    </div>
                </div>)}
            </div>
        </div>;
    }

    return <ProductsPanel selected={null} onSelect={() => {}} onOpen={setOpen} hideHeading
        emptyHint="Paste a product link or drop photos to add your first product." />;
}
```

Note: the test mock renders `AddToChatMenu` as a button labelled with its `label` prop. So the per-photo icon menus render as "Add to chat" buttons, and the product-level one renders as "Add photos to chat".

- [ ] **Step 4: Run the tests and type-check**

Run: `cd apps/web && npx vitest run components/platform/files/DriveProducts.test.tsx && npx tsc --noEmit -p .`
Expected: pass, with only the 3 known tsc errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/platform/files/DriveProducts.tsx apps/web/components/platform/files/DriveProducts.test.tsx apps/web/components/platform/chat/creative-library/productsApi.ts
git commit -m "feat(web): Drive Products view built on the product library"
```

---

### Task 5: Wire Drive (minimal edits in files another session owns)

**Files:**
- Modify: `apps/web/components/platform/files/systemFolders.ts`
- Create: `apps/web/components/platform/files/systemFolders.products.test.ts`
- Modify: `apps/web/components/platform/files/FilesList.tsx`
- Modify: `apps/web/app/[tenant]/dashboard/drive/page.tsx`

**Interfaces:**
- Consumes: `DriveProducts` and `listProductImageFileIds` (Task 4).
- Produces, from `systemFolders.ts`:
  - `PRODUCT_PREFIXES`
  - `isProductFileKey(key: string): boolean`
  - `uploadsWithOrphanProductFiles<T extends { id: string; key: string }>(files: T[], referencedIds: Set<string> | null): T[]`

- [ ] **Step 1: Write failing tests**

```ts
// apps/web/components/platform/files/systemFolders.products.test.ts
import { describe, expect, it } from 'vitest';
import { isProductFileKey, isSystemFolder, isUpload, uploadsWithOrphanProductFiles } from './systemFolders';

const file = (id: string, key: string) => ({ id, key });

describe('product files in Drive', () => {
    it('treats imported-products as a hidden system folder that is not an upload', () => {
        expect(isSystemFolder('imported-products')).toBe(true);
        expect(isUpload('imported-products/x.jpg')).toBe(false);
        expect(isProductFileKey('imported-products/x.jpg')).toBe(true);
        expect(isProductFileKey('creative-products/y.png')).toBe(true);
        expect(isProductFileKey('chat-attachments/z.png')).toBe(false);
    });

    it('adds product photos no product references to Uploads', () => {
        const files = [file('u1', 'chat-attachments/a.png'), file('p1', 'creative-products/b.png'), file('p2', 'imported-products/c.jpg'), file('g1', 'generated/d.png')];
        expect(uploadsWithOrphanProductFiles(files, new Set(['p1'])).map(f => f.id)).toEqual(['u1', 'p2']);
    });

    it('shows no product photos in Uploads while the referenced ids are still loading', () => {
        const files = [file('u1', 'chat-attachments/a.png'), file('p1', 'creative-products/b.png')];
        expect(uploadsWithOrphanProductFiles(files, null).map(f => f.id)).toEqual(['u1']);
    });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd apps/web && npx vitest run components/platform/files/systemFolders.products.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

**`systemFolders.ts`** (re-read it first; the other session may have changed it):
- Add `'imported-products': 'Imported products',` to `SYSTEM_FOLDER_LABELS`. `PILL_FOLDERS` doesn't change.
- Change `AGENT_OR_LIBRARY_PREFIXES` to `[...PILL_FOLDERS.map(folder => `${folder}/`), 'imported-products/']`.
- Add:

```ts
/** Where product photos live: uploaded ones and ones downloaded by a link import. */
export const PRODUCT_PREFIXES = ['creative-products/', 'imported-products/'] as const;

export function isProductFileKey(key: string): boolean {
    return PRODUCT_PREFIXES.some(prefix => key.startsWith(prefix));
}

/** Uploads plus product photos that no product uses anymore (e.g. after the
 *  product was deleted) — they're still the user's files. While the referenced
 *  ids are unknown (null), no product photo is shown, so none flash in. */
export function uploadsWithOrphanProductFiles<T extends { id: string; key: string }>(files: T[], referencedIds: Set<string> | null): T[] {
    return files.filter(f => isUpload(f.key) || (referencedIds !== null && isProductFileKey(f.key) && !referencedIds.has(f.id)));
}
```

**`FilesList.tsx`** (re-read it first). Make only these changes:
1. Imports: `useQuery` is already imported from React Query. Add `DriveProducts` from `./DriveProducts`, `listProductImageFileIds` from `@/components/platform/chat/creative-library/productsApi`, `uploadsWithOrphanProductFiles` from `./systemFolders`, and `type Attachment` from `@/types/agent-events`.
2. Split `addToChat` into `addAttachmentsToChat(attachments: Attachment[], conversationId: string | null)`, which contains the existing stage-and-push body, and a thin `addToChat(chosen, conversationId)` that maps `FileRecord` to `Attachment` and calls it. The behaviour is unchanged.
3. Add
   ```ts
   const { data: productImageIds } = useQuery({ queryKey: ['creative-products', 'image-file-ids'], queryFn: listProductImageFileIds });
   const referencedProductImageIds = useMemo(() => productImageIds ? new Set(productImageIds) : null, [productImageIds]);
   ```
   The query key sits under `['creative-products']`, so the product panel's invalidations refresh it.
4. In the `uploadFiles` memo, replace `allFiles.filter(f => isUpload(f.key))` with `uploadsWithOrphanProductFiles(allFiles, referencedProductImageIds)`, and add `referencedProductImageIds` to its dependencies. Remove the `isUpload` import if it's now unused.
5. Where the file grid or list renders (the `<div className="flex gap-4 items-start">` block), render `<DriveProducts conversations={conversations} canAddToChat={!!defaultAgentId} onAddToChat={addAttachmentsToChat} onDownload={mutations.downloadFile} />` in its place when `activeSystemFolder === 'creative-products'`. Also skip the file search, type and time filter row and the grid/list toggle in that case, because DriveProducts has its own search. Wrap that toolbar in the same condition. Change nothing else.

**`drive/page.tsx`:** hide the top-right upload button when `currentPrefix.startsWith('creative-products/')`, because DriveProducts has its own "paste a link or drop photos" box.

- [ ] **Step 4: Run the tests, type-check, and run the Drive and chat suites**

Run: `cd apps/web && npx vitest run components/platform/files/ components/platform/chat/ && npx tsc --noEmit -p .`
Expected: all pass, with only the 3 known tsc errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/platform/files/systemFolders.ts apps/web/components/platform/files/systemFolders.products.test.ts apps/web/components/platform/files/FilesList.tsx "apps/web/app/[tenant]/dashboard/drive/page.tsx"
git commit -m "feat(web): Drive's Products tab shows the product library"
```

---

### Task 6: Verification (no deploy)

- [ ] **Step 1: Rebase on `main`**, then run everything:

```bash
git fetch origin && git rebase origin/main
cd products/agent-platform/packages/api && pnpm type-check && pnpm exec vitest run && cd -
cd apps/web && npx tsc --noEmit -p . && npx vitest run components/platform/files/ components/platform/chat/ && cd -
```

Expected: green, apart from the known baselines (1 personas API test, 3 web tsc errors). Report the counts.

- [ ] **Step 2: Deploy steps, recorded for the user and not run:**
  1. `sam build && sam deploy` from the main checkout.
  2. Web deploy on the VM.
  3. `pnpm rename:product-files` from the laptop, with DATABASE_URL from `apps/api/.env`.
  4. Live check: Drive → Products shows named product cards; the `#` picker shows "campus shoes by fitnearn.jpg"; deleting a product moves its photos to Uploads.
