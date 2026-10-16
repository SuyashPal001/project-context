# Brand — design

Date: 2026-10-16
Status: draft, pending user review

## Goal

A workspace has one brand. The AI fills it from a website, an Instagram handle,
or a short chat, and every caption, image and ad after that follows it without
the user restating it.

Today there is nowhere to keep a brand. Olmo's working memory has a free-text
"Brand Context" block that only holds what the user said in chat and that Olmo
has rewritten wrongly before (`bed4ce00`). `composite_end_card` can place a
logo (`f5ad7513`), but nothing stores one, so it is passed by hand or not at
all. The `tenants` white-label fields (`brandName`, `logoFileId`,
`brandColor`) theme the app itself and must not be reused for ads.

## Decisions (agreed in brainstorming)

- **One brand per workspace.** Keyed on `tenantId`. Switching workspace switches
  brand, the same as products and Drive. Agencies with several clients are out
  of scope; someone with two brands uses two workspaces. "Copy brand from
  another workspace" may come later.
- **Follow naise's "My brand" page for content and layout.** Basics, Voice,
  Visual identity, a readiness line. The difference from naise: the AI fills
  every field and the user corrects, instead of the user typing into an empty
  form. (The products-library spec rejected naise's *manual* form; the AI-filled
  version is consistent with that.)
- **The brand page is visible.** Users see what the AI understood about their
  brand. What stays hidden is the prompts and how fields are inferred.
- **Three sources in v1:** website link, Instagram handle, or a chat interview
  when there is neither.
- **One-off changes for a single ad happen in chat.** "Use ocean colours and no
  logo on this one" changes that ad only. No override panel.
- **v1 is the brand page only.** naise's audit parts (social presence,
  competitors identified, SEO and AI-search gaps) are phase 2.
- **Mastra-native.** The model work is a Mastra workflow and a Mastra agent
  with `structuredOutput`, the brand reaches Olmo through `RequestContext` and the
  existing dynamic `instructions` resolver, and chat tools use `createTool`.
  Existing code is reused, not rewritten (see "Reuse").

## Out of scope (v1)

- Social presence, competitors, SEO/AEO checks (phase 2).
- naise's "My assets" grid. Product shots live in the Products library, faces
  in the avatar library.
- A per-ad override panel.
- Reading PDF brand guidelines.
- Brand per client (agency mode).
- Copying a brand between workspaces.

## Data

New file `products/agent-platform/packages/schema/creativeBrand.ts`, exported
from the agent-platform schema barrel, migration generated with drizzle-kit.
Pattern follows `creativeProducts.ts`.

Table `creative_brand`, one row per workspace (unique index on `tenant_id`).

| Group | Column | Type | Notes |
|---|---|---|---|
| Basics | `name` | text, not null | |
| | `one_liner` | text | One plain sentence saying what the brand makes. |
| | `audience` | text | |
| | `region` | text, default `IN` | One of `IN`, `US`, `UK`, `AE`, `SG`, `GLOBAL`, validated in Zod (not a DB enum, so adding one is a code change). |
| Voice | `tone_words` | text[] | 3 to 5. |
| | `emoji_policy` | text, default `minimal` | `none`, `minimal`, `moderate`, `expressive`, validated in Zod. |
| | `signature_phrases` | text[] | |
| | `banned_phrases` | text[] | |
| | `cta_examples` | text[] | |
| | `voice_notes` | text | Markdown. |
| Visual | `colors` | jsonb | `{ primary, secondary, accent, text, background, muted }`, each `#RRGGBB` or absent. |
| | `headline_font` | text | A font family name. |
| | `logo_file_id` | uuid, FK `files` | Stored in Drive. |
| | `favicon_file_id` | uuid, FK `files` | |
| | `mascot_file_id` | uuid, FK `files` | Upload only. |
| Source | `source_type` | text | `website`, `instagram`, `chat`. |
| | `source_value` | text | The URL or handle. |
| | `import_status` | text, default `idle` | `idle`, `importing`, `done`, `failed`. |
| | `import_error` | text | Plain reason, for logs; never shown raw. |
| | `imported_at` | timestamptz | |
| | `edited_by_user` | text[] | Column names the user has changed by hand or through `update_brand`. |
| | `created_by`, `created_at`, `updated_at` | | As in `creative_products`. |

Rules:

- Length caps for every text and array field are enforced in Zod at the API
  boundary, as `usps` is for products.
- **Readiness** is computed on read, not stored: ready when `name`, `audience`
  and `tone_words` are all non-empty.
- **The AI never fills `banned_phrases`.** A wrong ban silently blocks good copy.
- **`signature_phrases` must appear verbatim in the source text.** The merge step
  drops any that don't.
- **A row exists only once something is saved.** No brand means no row, and the
  page shows the empty state.

## Filling the brand

Revised after reading the code (2026-10-16): the Lambda already has an
SSRF-guarded fetch and Drive saving (`routes/products.import.ts`), and the VM
holds vendor keys in `.env` while the Lambda would need a new secret loader and
IAM grant. So the website read and image saving stay in the API, TikHub runs on
the orchestrator, and the Mastra workflow does the model work.

### Starting an import

`POST /brand/import` on the API Lambda, body
`{ source: 'website' | 'instagram', value: string }`.

1. Validate: a website must be `https://`; an Instagram value must parse to a
   handle (`@name`, `name`, or an `instagram.com/name` URL).
2. Upsert the row with `import_status = 'importing'`, `source_type`,
   `source_value`, `import_error = null`.
3. *Website:* fetch the home page with the guarded fetch extracted from
   `products.import.ts` (https only, SSRF check on every redirect, 8 s, 2 MB),
   plus the first linked stylesheet (3 s, 512 KB). `extractBrandPage(html, css,
   url)` returns raw facts: `og:site_name` / `<title>`, meta description, text
   of `h1`–`h3`, button and link texts that look like calls to action, JSON-LD
   `Organization.logo` and `name`, icon links, `theme-color`, CSS colour
   custom properties and hex colours by frequency, and `font-family` values.
   It reuses `jsonLdCandidates` from `productPageExtract.ts`.
4. Call the orchestrator's `/internal/brand/import` (`X-Service-Key`) with
   `{ tenantId, source, handle? , facts? }`. The orchestrator starts
   `brandImportWorkflow` and acks at once.
5. Return `202` with the row. The page and chat poll `GET /brand`.

If the page cannot be read or the orchestrator does not ack, the row is set to
`failed` right away.

### `brandImportWorkflow` (orchestrator)

`apps/agent-orchestrator/src/mastra/workflows/brandImportWorkflow.ts`,
registered on the Mastra instance next to `skill-draft`.

1. **gather.** Website: passes the facts through. Instagram: one TikHub
   user-info call (`TIKHUB_API_KEY` in the orchestrator `.env`), returning name,
   bio, external link, profile picture URL, and the last 12 captions.
2. **fill.** `brandFillAgent` (a Mastra `Agent` on `liteModel`, no tools)
   called with `structuredOutput: { schema: brandFillSchema }`. The best logo
   candidate image is sent with the text. Instructions: plain one-liner, infer
   audience and region, 3 to 5 tone words, emoji policy from the copy, CTAs
   from real text, colours from CSS when present else from the logo, font from
   CSS. The schema has no `banned_phrases` and string enums only (Gemini
   rejects numeric enums). Usage is logged with `persistCost`.
3. **report.** POSTs the result to the API's
   `/api/v1/internal/brand/import-result` (`x-internal-service-key`):
   `{ tenantId, ok: true, fields, logoUrl, faviconUrl, sourceText }`, or
   `{ tenantId, ok: false, error }` if any step threw.

### Saving the result (API)

`/internal/brand/import-result` downloads `logoUrl` and `faviconUrl` with the
same guarded image import used for products (jpeg, png, webp; 8 MB), stores
them in Drive under `brand/`, then merges:

- skips every column in `edited_by_user`;
- drops signature phrases not found verbatim in `sourceText`;
- never writes `banned_phrases`;
- sets `import_status = 'done'`, `imported_at`.

A failed image download leaves that field as it was. A report for a tenant
whose row is not `importing` is ignored (a newer import or a manual edit won).

**Stuck runs:** `GET /brand` reports a row that has been `importing` for more
than 3 minutes as `failed` with a generic reason, so a crashed workflow never
leaves the page spinning.

**Refresh** re-runs the import against the stored source; edits survive.

### When there is no link

Olmo runs a short interview in chat (name, who it is for, how it should sound,
then "send your logo if you have one") and saves each answer with
`update_brand`. A logo sent in chat is saved with `update_brand`'s `logoFileId`.
Colours from the logo are a follow-up, not v1.

### Failures the user sees

- Site blocks the fetch (like Tira's 403) or TikHub fails: the page shows
  "Couldn't read that. Tell Olmo about your brand instead," with the chat link.
- Partial read: whatever was found is shown; missing fields stay empty.
- No provider names, status codes or "blocked" wording reach the user.

### Cost

The import is not charged to the user, the same as product naming. Gemini and
TikHub costs are logged for us.

## Using the brand

### Loading

`apps/agent-orchestrator/src/routes/chatStream.ts` loads the tenant's brand row
once per turn and sets `requestContext.set('brand', brand)`, next to the
existing `tenantId` and `agentName` keys. `TenantContext` gains an optional
`brand` key.

### Olmo's instructions

In the existing `instructions` resolver in
`apps/agent-orchestrator/src/mastra/agents/platformAgent.ts`, append a
`## Your brand` block **after** the stable contracts, only when a brand
exists. It lists name, one-liner, audience, region, tone words, emoji policy,
signature phrases, banned phrases, CTAs, colours and font, and says to follow
them in all copy and visuals unless the user asks otherwise for one piece of
work. Placing it last keeps the stable prefix cacheable, per Mastra's
context-engineering guidance. This is an addition; no existing instruction is
removed.

### Chat tools (`createTool`)

- **`update_brand`**: saves fields the user stated ("we never say 'cheap'",
  "our audience is new mums"). Each saved field is added to `edited_by_user`.
  Calls the API's `PATCH /brand`.
- **`import_brand`**: starts an import when the user pastes a site or handle in
  chat. Calls `POST /brand/import`.

No `get_brand` tool: the brand is already in the instructions.

### Generation tools

Defaults come from code, not prompt rules:

- `composite_end_card` uses the brand logo (`requestContext.brand.logoFileId`)
  when no `logoFileId` is given, and `noLogo: true` turns it off for one ad.
- Colours and tone reach image and video prompts through Olmo's `## Your
  brand` block in v1. Wiring them into the prompt builders in code is a
  follow-up once the block is proven in live runs.

### One-off changes

Said in chat; Olmo passes them as arguments to that generation call. Nothing is
saved to the brand.

### Working memory

The "Brand Context" block in `WORKING_MEMORY_TEMPLATE` stays, keeping default
ratio, default duration and standing exclusions. The working-memory contract
gains one line: the brand's name, voice, audience, phrases and colours live in
the brand and are saved with `update_brand`, not in working memory. Addition
only.

## API

All under the secure API, mounted below `usageRecordingMiddleware` per
CLAUDE.md, every query filtered by `tenantId`.

- `GET /brand`: the row plus computed readiness and presigned URLs for logo,
  favicon and mascot. Returns `{ data: null }`, not a 404, when there is no brand.
- `PATCH /brand`: partial update, Zod-validated; adds changed columns to
  `edited_by_user`.
- `POST /brand/import`: as above.
- `POST /internal/brand/import-result`: internal, as above.
- `POST /brand/images`: set or clear logo, favicon or mascot from an uploaded
  `files` id.

## Page

Route `apps/web/app/[tenant]/dashboard/brand/page.tsx`. Main sidebar item
**Brand**, next to Drive.

The existing `dashboard/branding` page (app white-label) stays under Settings;
its sidebar label becomes **"Workspace look"** so the two are not confused. The
route does not change.

### Empty

One input, "Paste your website or Instagram handle", which detects the type
from the value. Below it: "No website? Tell Olmo about your brand", which opens
a chat with "Set up my brand" prefilled.

### Importing

Section headings with shimmer rows and "Reading yourbrand.com…". Polls
`GET /brand` every 2 s. Leaving the page does not stop the run.

### Filled

- **Readiness line:** "Olmo needs three things to write like {name}", ticks for
  name, audience, voice.
- **Basics:** name, one-liner, audience, region chips (India, US, UK, UAE,
  Singapore, Global).
- **Voice:** tone words as removable tags, emoji policy as 4 chips, signature
  phrases, banned phrases and CTAs one per line, voice notes. "See examples"
  hints where they help.
- **Visual identity:** logo, favicon and mascot thumbnails with replace and
  remove; 6 colour swatches with hex, click to edit; font picked from 6 or
  typed. **Refresh** re-reads the source and keeps edits.
- **Source line:** "Filled from yourbrand.com · 2 days ago", with change
  source.

Every field saves on blur via `PATCH /brand`; no Done buttons.

### Mockups (approved 2026-10-16)

Sidebar:

```text
  Chat
  Drive
  Brand        ← new
  Skills
  Settings ›   ("Branding" renamed "Workspace look")
```

Empty:

```text
  Brand
  How your brand sounds and looks. Every ad Olmo makes follows it.
  ─────────────────────────────────────────────────────────────
        Paste your website or Instagram handle
        [ yourbrand.com  or  @yourbrand          ]  [ Fill in ]
        No website?  Tell Olmo about your brand →
```

Filled (sample values are illustrative):

```text
  Brand                                                    [↻ Refresh]
  Olmo needs three things to write like Mamaearth:
  ✓ Name   ✓ Audience   ✓ Voice

  Basics
  ─────────────────────────────────────────────────────────────
  Brand name        Mamaearth
  One-liner         Toxin-free skincare and haircare made with natural ingredients.
  Audience          Women 22–35 in Indian cities who want safe, natural products.
  Region            (●India) (US) (UK) (UAE) (Singapore) (Global)

  Voice
  ─────────────────────────────────────────────────────────────
  Tone words        [warm ×] [caring ×] [honest ×] [upbeat ×]  + add
  Emoji             (None) (●Minimal) (Moderate) (Expressive)
  Signature phrases Goodness inside / Made safe
  Banned phrases    (empty — the AI never guesses these)
  CTAs              Shop now / Comment 'GLOW' for the link
  Voice notes       ## What we say … ## What we avoid …

  Visual identity
  ─────────────────────────────────────────────────────────────
  Logo / Favicon    [img] Replace · Remove
  Mascot            Not set   Upload
  Colours           Primary #00A651  Secondary #0B3D2E  Accent #F7B500
                    Text #1A1A1A     Background #FFFFFF Muted #6B7280
  Font              Poppins ▾
  ─────────────────────────────────────────────────────────────
  Filled from mamaearth.in · 2 days ago · Change source
```

Chat interview (no website): Olmo asks name, who it is for, how it should
sound, then "Send your logo if you have one", saves each answer with
`update_brand`, and ends with "Saved … See it on the Brand page →".

### Style

No boxed containers: sections are a heading and rows with hairline dividers.
Rose accent. Checked in light and dark. No credit counts. `tsc` on `apps/web`
before pushing.

## Reuse

| Need | Reused |
|---|---|
| Fetching a page safely | `guardedFetch`, `readCapped`, `importOneImage` moved out of `routes/products.import.ts` into `lib/safeFetch.ts`, used by both imports. |
| Reading a page | `jsonLdCandidates` from `productPageExtract.ts`, cheerio. |
| Running the import | Mastra workflow (`createWorkflow`/`createStep`), as `skillDraftWorkflow`. |
| Filling fields | Mastra `Agent` with `structuredOutput`, as `skillDraftAgent` / `formatterAgent`. |
| Model | `liteModel` from `mastra/model.ts`, through the inference gateway. |
| Cost logging | `persistCost`. |
| Internal auth | `isInternalServiceKey` (orchestrator), `isAuthorized` (API). |
| Per-request data to Olmo | `fetchTenantBrand` (pg pool, like `fetchAgentName`) set on `RequestContext` in `chatStream.ts`, read in the existing `instructions` resolver. |
| Chat tools | `createTool`, calling the user API with the turn's `idToken` like `persistence.ts`. |
| Images | `files` rows in Drive via `storageService.putFileForTenant`. |
| Table shape | `creativeProducts.ts`. |

## Testing

- **Unit:** extractor's new fields against saved HTML from real sites; Instagram
  handle parsing; merge never overwrites `edited_by_user` columns; invented
  signature phrases are dropped; `banned_phrases` is never written by import;
  Zod limits.
- **Workflow:** `brandImportWorkflow` end to end with `brandFillAgent` and TikHub
  mocked, including a failing read step and a failing logo download.
- **Orchestrator:** the `## Your brand` block appears only when a brand exists;
  `composite_end_card` picks up the brand logo by default and respects an
  explicit no-logo.
- **Live (through the internal test MCP):** import a D2C website, an
  Instagram-only brand, and a site that blocks us; then ask Olmo for an ad and
  check the logo lands on the end card and the copy follows the tone and
  banned phrases.

## Deploy order

1. Migration for `creative_brand`.
2. Add `TIKHUB_API_KEY` to `apps/agent-orchestrator/.env` on the VM.
3. Orchestrator (workflow, agent, tools, instructions block), build and
   `pm2 restart`.
4. `sam build && sam deploy` from the main checkout (API routes).
5. Web (`./deploy.sh`).

Orchestrator before Lambda, so `/brand/import` never calls a missing route;
Lambda before web, so the page never 404s.

## Phase 2 (not this spec)

naise's audit: social presence (followers and growth), competitors identified
(TikHub related profiles filtered by an LLM), and SEO / AI-search gaps. These
feed the planned ad-research step.
