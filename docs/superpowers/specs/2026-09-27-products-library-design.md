# Products library — design

Date: 2026-09-27
Status: draft, pending user review

## Goal

A user adds a product once, in seconds, without typing, and every ad after that
knows exactly what it is selling.

Today a "product" is a loose image file under the `creative-products/` storage
prefix. Olmo receives the filename as the product name (`- Product: _.jpeg`),
link imports are thrown away when the chat ends, a product can only have one
image, and nothing can be renamed or deleted. This design turns a product into
a saved record that the AI fills in.

## Principles (agreed in brainstorming)

- **Follow the market pattern unless ours clearly makes more sense.** Higgsfield
  Marketing Studio (`higgsfield-ai/skills`, MIT, cloned to
  `~/Desktop/open-source-projects/higgsfield-skills`) models a product as a saved
  record with a title, a description and several images. It is created from a
  link by default or from uploaded photos. Brand kit and product are both
  optional inputs to an ad. We follow that. Naise's manual brand form is the
  pattern we deliberately do not copy.
- **The AI fills things in, not the user.** Higgsfield still makes the user
  type a title and description for uploaded photos. We use AI to name them
  instead.
- **Minimal UI.** One entry point, no required fields, no edit dialog. Rename
  and Delete are the only product actions.
- **Nothing blocks sending.** A missing or unclear product is resolved by Olmo
  in one chat message, before any credits are spent.

## User experience

### Products tab

- **One drop zone:** "Paste a product link or drop photos". It takes a click,
  drag-and-drop, or a pasted link. On first visit, one line below it says:
  "You can skip this. Olmo will ask about your product in chat."
- **Link:** a card appears at once with a spinner. It fills in the name, main
  image and description from the page, and the product is saved and selected.
- **Photos (1–6 at once):** a card appears at once showing the first photo and
  "Naming…". A few seconds later the AI's name appears. The product is saved and
  selected.
- **Link fails:** no product is saved. An inline message under the drop zone
  says: "Couldn't read this page. Drop a product photo instead." (The earlier
  chat draft proposed a card named after the site. That was dropped: a product
  with no name and no image is useless in the grid and has to be deleted by
  hand.)
- **Grid:** each card shows the main image and the product name, never a
  filename. Click a card to select it. The ⋯ menu has Rename (inline) and
  Delete. Search matches name and description.
- **Existing loose images** under `creative-products/` become products through
  a one-off backfill, each AI-named.

### Selection behaviour

One product per ad, and the most recent pick wins. Everything uploaded is saved,
whether or not it is used.

| What the user does | What happens |
|---|---|
| Uploads photos and does nothing else | Saved and selected. They can just send. |
| Uploads, then clicks a different product | The ad switches to the clicked one. The upload stays saved in the grid. |
| Uploads, then removes the product chip (✕, exists today) | The ad goes with no product. The upload stays saved. Olmo asks about the product in chat. |
| Picks nothing | No product. Olmo asks in chat. |
| Picks product A and attaches a photo of product B in the message | Olmo notices the mismatch and asks which to use. It never guesses. |
| Sends before naming finishes | The image is attached. The brief says the name is not known yet, and Olmo's check asks. |

### What Olmo receives

```
- Product: The Ordinary Niacinamide 10% + Zinc 1%
  A lightweight serum for blemish-prone skin. ₹590
  Source: https://theordinary.com/...
  Use the attached product image as the visual reference.
```

The main image is attached as today. Price and source appear only when present.

### Olmo's check (the gap-checklist rule)

Before the first paid generation of an ad, Olmo confirms the product in one
line: "I'll make this for The Ordinary Niacinamide serum, a blemish serum, ₹590.
Right?" It asks only about what is missing or conflicting, and never re-asks
something the brief already states. This adapts Higgsfield's brandkit intake
rule: "a gap checklist, not a mandatory questionnaire".

## Data model

New table `creative_products` in
`products/agent-platform/packages/schema/creativeProducts.ts`, exported from
that package's `index.ts`. The migration is generated with drizzle-kit from
`packages/foundation/database`, whose config already includes the agent schema.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `tenant_id` | uuid not null → tenants | Every query filters on it. |
| `name` | text not null | Placeholder "Untitled product" until named. |
| `description` | text null | |
| `price` | text null | As extracted, e.g. "₹590". Never typed by users. |
| `source_url` | text null | Set by link imports. |
| `image_file_ids` | uuid[] not null default `{}` | Ordered. The first one is the main image. These are `files` rows, so they stay tenant-scoped and visible in Drive. |
| `naming_status` | enum `pending` / `done` / `failed` | Drives the "Naming…" state. |
| `created_by` | uuid → users | |
| `created_at`, `updated_at` | timestamptz | |

**Why not reuse `creative_library_assets`?** It was built for platform-owned
presets. Its `storage_key` is a single, required S3 key that bypasses `files`,
and its `tenant_id` is nullable by design. Products are tenant-owned, have
several images and need a naming state. Stretching that table would weaken it
for avatars.

**Why an array rather than an image join table?** Images are always loaded
together, are ordered, and carry no per-image data. A join table would add a
second table and extra writes for no current need. The cost is that there is no
foreign key, so reads drop ids whose `files` row no longer exists.

Deleting a product deletes the row only. Its image files stay in Drive, the
same as every other generated or uploaded file.

## API

New routes in `products/agent-platform/packages/api/routes/products.ts`,
mounted through `mountApiRoutes` as `/products`. That puts them below the full
middleware chain (tenant resolution, entitlements, permissions), not beside
`/onboarding`. Every route requires the tenant and checks `files` permissions,
the same as the existing import route.

| Route | Does |
|---|---|
| `GET /products?q=&limit=&offset=` | Lists the tenant's products, newest first. `q` matches name and description (ILIKE). Each product comes back with its image file records. |
| `POST /products` `{ fileIds: uuid[] (1–6) }` | Creates a product from already-uploaded image files (the client uses the existing upload flow). Checks that every file belongs to the tenant and is an image. Returns the product with `naming_status: pending`. |
| `POST /products/:id/describe` | Runs AI naming on the main image, synchronously, then writes `name`, `description` and `naming_status` and returns the product. The web calls it right after `POST /products`. |
| `POST /products/import` (existing) | Unchanged extraction. It now also creates the product row (title, description, price, source URL, all imported images) and returns `{ data: product }`. If the page has images but no title, it creates the product and the web then calls describe. If it has no images at all, it returns 422 and nothing is saved. |
| `PATCH /products/:id` `{ name }` | Rename. The name is trimmed, 1–120 characters. |
| `DELETE /products/:id` | Deletes the row. |

Imported images keep their `imported-products/` prefix. The grid no longer
lists files by prefix, so the prefix only matters for Drive.

### AI naming

- **Why it goes through the orchestrator:** the API Lambda has no inference
  gateway URL, but it already calls the orchestrator over
  `AGENT_ORCHESTRATOR_URL` with the internal service key (the watchdog and the
  files ingest relay do this). The orchestrator runs next to the gateway.
- **Flow:** the API downloads the main image with
  `storageService.downloadFile(tenantId, fileId)`. It then POSTs
  `{ imageBase64, mimeType }` to a new orchestrator route,
  `POST /internal/products/describe`, which checks `X-Service-Key`.
- **The orchestrator call:** it calls the gateway with the same model
  `analyzeImage.ts` uses (`gemini-3.6-flash`) and asks for JSON
  `{ name, description }`.
  - `name`: 60 characters or fewer. It uses the brand and product text visible
    on the item, if any.
  - `description`: one sentence, 140 characters or fewer, describing only
    what is visible. No claims, benefits or prices.
  - If the image is not a product (a room, say), it still names what it shows.
    The user can rename or delete it.
- **Timeouts:** 15 s on the gateway call, and 20 s on the whole API route,
  inside the Lambda's 29 s limit.
- **On any failure:** `naming_status = failed` and the name stays "Untitled
  product". The card shows the placeholder, and the user can rename it. The
  brief tells Olmo the name is unknown.
- **Billing:** naming is not charged to the tenant. It is one small
  image-reading call per product. It is logged with the tenant id so the cost
  can be watched.

## Web

In `apps/web/components/platform/chat/`:

- **`CreativeLibrary.tsx` `ProductsPanel`:** rewritten around `GET /products`.
  - One drop zone: file input with `multiple`, 1–6 images, JPG/PNG/WebP,
    35 MB each as today, plus a link field.
  - Optimistic cards with "Naming…" and import spinners.
  - The ⋯ menu offers Rename (inline input) and Delete (with an undo toast,
    the same pattern as chat archive).
  - Search is sent to the server.
  - The artwork-heavy empty state shrinks to the drop zone and the skip line.
- **`creative-library/creativeBriefModel.ts`:** a new selection kind,
  `{ kind: 'product', productId, name, description, price, sourceUrl,
  namingStatus, attachment }`, where `attachment` is the main image.
  - The old `product-image` and `product-url` kinds stay parseable, because
    saved drafts restore through `creativeBrief.ts`, but new selections use
    only `product`.
  - `ProductImportCard.tsx` is removed. Import results become products,
    shown as cards.
- **`creative-library/creativeBrief.ts`:** builds the product lines shown
  above, and attaches the main image through the existing
  `mergeCreativeBriefAttachments` / `creativeBriefAttachmentIds` path.

## Olmo prompt

This is an additive change to `platformAgent.ts`. Existing contracts keep their
wording, per the additive-only rule for prompt changes. A new short "Product
confirmation" block says:

- When a brief names a product, confirm it in one line before the first paid
  generation, and ask only about missing or conflicting parts.
- If the brief says the name is unknown, ask what the product is.
- If a message attaches an image that does not match the selected product, ask
  which one to use.
- Never re-ask what the brief already states.

The existing Product-photo reuse contract still applies. This block only runs
before it.

## Backfill

A one-off script, `products/agent-platform/packages/api/scripts/backfill-creative-products.ts`:

- For each tenant, each image file under `creative-products/` that no product
  references becomes a product: one product per file, named through the same
  describe path.
- It is idempotent (it skips files already referenced) and runs by hand.
- Only `dev` exists today, so it runs once there.

## Testing

- **API:** `products/agent-platform/packages/api/__tests__/` (this package only
  runs tests from that folder). Real Hono `app.request` with mocked `db`,
  `storageService` and orchestrator fetch, following
  `creativeLibraryAssets.test.ts`.
  - Tenant isolation on every route.
  - Create rejects another tenant's file.
  - Describe success, gateway failure and timeout (each sets `naming_status`).
  - Import creates the row, and import with no images saves nothing.
  - Rename validation, and delete.
- **Orchestrator:** `/internal/products/describe`.
  - Rejects without the service key.
  - Parses the model JSON and truncates over-long fields.
  - Returns a clear error on bad JSON.
- **Web:**
  - `CreativeLibrary.test.tsx`: drop photos creates and names the product, a
    link creates it, a failed link shows the message, click selects, rename
    and delete.
  - `creativeBrief.test.ts`: product lines, unknown-name line, old kinds still
    restore.
- **Prompt:** a contract test that the new block exists and the old contract
  text is unchanged.

## Deployment

- Generate and apply the migration.
- Run `sam build` / `sam deploy` for the API Lambda, from the main checkout,
  never a worktree.
- Rebuild the orchestrator and run `pm2 restart` on it (`./deploy.sh` does not
  restart the orchestrator).
- Rebuild the web app.
- Run the backfill.

## Out of scope

- Brand: name, logo, colours, tone and audience, from one website link. This is
  the next design and will reuse this table's pattern. Products will later
  belong to a brand.
- Categories, folders, several products in one ad, App Store or web products,
  and sharing products across workspaces.
- Editing description or price, adding or removing photos after creation, and
  choosing a different main image.
- Charging for AI naming.
