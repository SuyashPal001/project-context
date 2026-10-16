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
- **Mastra-native.** The import is a Mastra workflow, the fill is a Mastra agent
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

### Starting an import

`POST /brand/import` on the API Lambda, body
`{ source: 'website' | 'instagram', value: string }`.

1. Validate: a website must be `https://`; an Instagram value must parse to a
   handle (`@name`, `name`, or an `instagram.com/name` URL).
2. Upsert the row with `import_status = 'importing'`, `source_type`,
   `source_value`.
3. Call the orchestrator's `/internal/brand/import` with the internal service
   key. It starts `brandImportWorkflow` and returns at once.
4. Return `202` with the row. The page and chat poll `GET /brand`.

The import runs in the orchestrator because the work (fetch, logo save, model
call) can exceed the web proxy's 15 s abort, and because a Mastra workflow
gives a persisted run and a trace in `mastra_span_events` for free.

### `brandImportWorkflow` (orchestrator)

New file under `apps/agent-orchestrator/src/mastra/workflows/`, registered on
the Mastra instance like `prdWorkflow`.

Steps:

1. **readSource.** Gathers raw facts; no model call.
   - *Website:* one GET of the home page, then cheerio extraction:
     `og:site_name` / `<title>`, meta description, visible text of `h1`–`h3`
     and buttons/links that look like calls to action, JSON-LD
     `Organization.logo` and `name`, `<link rel=icon>` and `apple-touch-icon`,
     `<meta name=theme-color>`, and from inline `<style>` plus the first linked
     stylesheet: CSS custom properties holding colours and the first
     `font-family` values.
   - *Instagram:* one TikHub user-info call (`fetch_user_info_by_username_v2`,
     tested 2026-10-02): full name, bio, external link, profile picture, and the
     last 12 posts' captions and thumbnails. Needs a new secret
     `project-context/{env}/tikhub-api-key`.
2. **saveImages.** Downloads the best logo candidate (JSON-LD logo, else
   `apple-touch-icon`, else the Instagram profile picture) and the favicon,
   and stores each as a `files` row in Drive under a `brand/` folder. Uses the
   same upload path generation tools already use. A failed download leaves the
   field empty; it never fails the run.
3. **fill.** `brandFillAgent` (a Mastra `Agent`, model through the inference
   gateway, Gemini Flash) with `structuredOutput` set to the brand Zod schema
   minus `banned_phrases`. Input is the raw facts from step 1 plus the logo
   image. Instructions: write a one-liner in plain words, infer audience and
   region (domain, currency, language), pick 3 to 5 tone words, pick an emoji
   policy from the captions or copy, take CTAs from real button and caption
   text, take colours from CSS when present and otherwise from the logo or post
   images, take the font from CSS. Cost is recorded with `persistCost`.
4. **merge.** Writes the result into the row, skipping every column listed in
   `edited_by_user`, dropping signature phrases not found verbatim in the source
   text, then sets `import_status = 'done'` and `imported_at`.

Any step failing sets `import_status = 'failed'` with a plain `import_error`
for the logs. Partial results from completed steps are kept.

**Refresh** on the page re-runs the same import against the stored source.
Because merge skips `edited_by_user`, the user's edits survive.

### When there is no link

Olmo runs a short interview in chat (name, who it is for, how it should sound,
then "send your logo if you have one") and saves each answer with
`update_brand`. Colours come from the logo if one is sent, using the same fill
agent on the logo alone. No workflow run is needed.

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

- `composite_end_card` and `render_animatic` use `requestContext.brand`'s logo
  when no logo argument is given. An explicit "no logo" from the user is passed
  as an argument and wins.
- Image and video prompt builders read colours and tone from the same place.

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

### Style

No boxed containers: sections are a heading and rows with hairline dividers.
Rose accent. Checked in light and dark. No credit counts. `tsc` on `apps/web`
before pushing.

## Reuse

| Need | Reused |
|---|---|
| Reading a page | `productPageExtract.ts` (cheerio, JSON-LD, og tags), moved into a shared agent-platform package so the API and orchestrator both import it, with new extractors for logo, favicon, theme-color, CSS colours and fonts. Same arrangement as `@serverless-saas/agent-credits`. |
| Running the import | Mastra workflow, as `prdWorkflow` / `remake/workflow.ts`. |
| Filling fields | Mastra `Agent` with `structuredOutput`, as `formatterAgent`. |
| Model calls | Inference gateway, as every agent. |
| Cost logging | `persistCost`. |
| Internal auth | `isInternalServiceKey`, as `/internal/products/describe`. |
| Per-request data to Olmo | `RequestContext` set in `chatStream.ts`, read in the existing `instructions` resolver. |
| Chat tools | `createTool`. |
| Images | `files` rows in Drive, as product images. |
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
2. Seed `project-context/dev/tikhub-api-key`.
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
