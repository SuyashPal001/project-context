# Drive Products view — design

Date: 2026-09-27
Status: approved in chat, pending spec review
Builds on: `docs/superpowers/specs/2026-09-27-products-library-design.md` (live on dev)

## Problem

Drive's **Products** tab and the composer's Products library disagree:

| | Products library (composer) | Drive → Products |
|---|---|---|
| Lists | saved products (`creative_products`) | raw files under `creative-products/` |
| Names | product name | filename (`Screenshot 2026-…`, `f5c10d58-….png`) |
| Imported products | shown | missing (saved under `imported-products/`) |
| Deleted products | gone | their photos still show |
| A 3-photo product | 1 card | 3 cards |

There are two more problems:
- Drive's **"New product"** button uploads a loose file and never creates a product.
- The `#` file picker shows raw filenames, so a renamed product appears under its old file name.

The user expects the product library and Drive to show the same products under the same names.

## User experience

**Drive → Products tab**
- One card per product: main photo, product name and photo count, in the same order and with the same data as the composer's Products tab.
- The card's ⋯ menu has Rename, Delete (with Undo), **Add to chat** and **Download photos**.
- Clicking a card opens that product's photos as normal Drive file cards. Each photo can be downloaded or added to chat individually.
- **+ New product** opens the same "Paste a product link or drop photos" box as the composer. It uses the same flow (link import or photo drop, then AI naming), and the result shows up in both places.
- Search matches the product name and description, the same as the composer.

**Everywhere else**
- **Product photo files are named after their product:** `<product name>.<ext>`, then `<product name> (2).<ext>`, and so on, in image order. This happens whenever the product's name is set: by AI naming, by a link import with a title, or by a rename. The `#` picker, attachment cards, Drive and downloads then all show the product name.
- **Photos of deleted products** leave the Products tab and appear under **Uploads**. They stay in Drive.
- **`imported-products/`** is hidden at the Drive root, like the other system folders.

**Unchanged:** the All, Uploads, Avatars and Generated tabs, apart from the Uploads rule above.

## Architecture

### API — `products/agent-platform/packages/api`
- New `renameProductFiles(tenantId, imageFileIds, productName)` in `lib/productRecords.ts`.
  - Updates `files.name` for each id, scoped by tenant and skipping soft-deleted rows.
  - Name format: `${productName}${i === 0 ? '' : ` (${i + 1})`}${ext}`, where `ext` is taken from the file's current name. If the current name has no extension, it falls back to one derived from `mime_type` (`.jpg`, `.png` or `.webp`).
  - Names are trimmed to the column limit (`files.name` is varchar 255): the product name is shortened first, and the extension and suffix are kept.
  - Only `files.name` (the display name) changes. `files.key` and the S3 path are never touched.
- Called from every place that sets a product's final name:
  - `renameProduct`;
  - `applyNamingResult`, only when a name was actually applied (the row was still pending and the result was non-null);
  - `createProduct`, when `namingStatus === 'done'` (a link import with a title).
  - It is not called for the placeholder "Untitled product".
- A one-off script, `scripts/rename-product-files.ts`, renames the photos of existing products whose status is `done`. It is idempotent. It needs DATABASE_URL only and runs from a laptop (the VM can't run scripts).

### Web — `apps/web/components/platform`
- **Move `ProductCard`** out of `chat/creative-library/ProductsPanel.tsx` into `chat/creative-library/ProductCard.tsx`. Its props gain optional extra menu items, so Drive can add "Add to chat" and "Download photos". Behaviour in the composer is unchanged.
- **New `files/DriveProducts.tsx`**:
  - uses `productsApi.ts` (list, create, import, describe, rename, delete) and the shared `ProductCard`;
  - reuses the drop-zone and link-import logic by extracting it from ProductsPanel into a small shared hook or component (`useProductCreation` or `ProductDropZone`), so there is no copy-paste;
  - clicking a card sets local state to show that product's photos in a normal file grid, with a Back link;
  - "Add to chat" calls the existing `stagePendingAttachments` with the product's images, then follows Drive's existing new-session / existing-chat choice;
  - "Download photos" downloads each image through the existing file-download path.
- **Minimal edits to files another session is actively changing:**
  - `files/systemFolders.ts`: add `'imported-products'` to `SYSTEM_FOLDER_LABELS` (hidden at the root, no pill). Export `PRODUCT_PREFIXES = ['creative-products/', 'imported-products/']` and exclude those prefixes in `isUpload`.
  - `files/FilesList.tsx`: when the active pill is `creative-products`, render `<DriveProducts />` instead of the file grid. Uploads also includes product-prefix files that no product references, using the product list's image ids. No other changes.
- Re-check `main` for new Drive commits before starting and before merging.

## Error handling
- Renaming files happens inside the same request as the product change. If the file rename fails, it is logged and the product change still succeeds, because the product name is the source of truth. The one-off script can fix any drift later.
- DriveProducts shows the same toasts and errors as the composer panel.

## Testing
- **API (`__tests__/`):**
  - `renameProductFiles` names files in order;
  - it keeps each file's extension;
  - it falls back to an extension from the mime type;
  - it trims long names;
  - it only touches the given tenant.
  - `renameProduct`, `applyNamingResult` and titled `createProduct` call it;
  - placeholder and failed naming don't.
- **Web:**
  - Drive's Products tab shows product cards (name and count), not files;
  - clicking a card shows its photos;
  - Rename and Delete work there;
  - "New product" creates a product;
  - Uploads includes the photos of a deleted product;
  - `imported-products` is hidden at the root;
  - ProductsPanel tests still pass after the ProductCard move.

## Deployment
Web and API only: no migration and no orchestrator change. The order is `sam build/deploy` (from the main checkout), then the web deploy, then run `scripts/rename-product-files.ts` once from the laptop.

## Out of scope
Adding or removing photos on an existing product, choosing the main photo, multiple products per ad (decided: not wanted), and brand (parked).
