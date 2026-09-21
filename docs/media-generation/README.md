# Media Generation

## Status — verified against code, 2026-09-16

The section below (dated 2026-09-15) undersold what exists. It was written
against the creative-library milestone only and never updated once the
generation tools landed a few days earlier (commits from 2026-09-10). Verified
directly against the code on `main` today:

### Shipped and real, not stubs

- **`generate_image`** (`apps/agent-orchestrator/src/mastra/tools/generateImage.ts`) —
  calls the gateway's `/v1/images/generations`, model `gemini-3-pro-image-preview`,
  synchronous. Charges credits before upload, refunds on storage failure,
  uploads via `uploadGeneratedFile` (rides the user's own `idToken`, forwarded
  from chat request context — not a service-key call).
- **`edit_image`** (`editImage.ts`) — same shape, reference-image editing.
- **`generate_video`** (`generateVideo.ts`) — text-to-video, model
  `gemini-omni-1.1-flash`, **synchronous** (direct fetch, no job id, no
  polling — this is not the async Veo path Phase 2 below describes).
- **`generate_song`** (`generateSong.ts`) — wired to `producerAgent`.
- **`analyze_video`** (`analyzeVideo.ts`) — two modes (`quick`/`deep`, not
  the four-pass forensic/structured/look-grade/narrative split some
  competitor teardowns describe), samples 8 or 20 frames, calls the gateway's
  chat-completions path.
- **Approval gating is native Mastra, already wired.** Every generation tool
  sets `requireApproval: async (_input, ctx) => shouldRequireApproval(...)`
  (`generationApproval.ts`), using `@mastra/core`'s built-in
  `requireApproval`/suspend-resume primitive — not a hand-rolled confirm loop.
- **Credit rates are seeded**, not just planned:
  `packages/foundation/database/seeds/credit-rates.ts` has live rows for
  `image_generation` (`gemini-3-pro-image-preview`) and `video_generation`
  (`gemini-omni-1.1-flash`).
- **`director` and `producer` are real sub-agents**, not a gap — Olmo
  delegates to them (`olmoDelegates.ts`), they hold the generation tools
  above. This already matches the "orchestrator + specialist agents + tool
  surface" shape described in outside teardowns of similar products.
- **Endpoint shape diverges from the design decision below.** The gateway
  ships three modality-specific routes — `/v1/images/generations`,
  `/v1/music/generations`, `/v1/video/generations`
  (`apps/inference-gateway/src/index.ts:466-486`) — not the unified
  `POST /v1/generations` discriminated envelope the "Design decisions
  already settled" section specifies. Either update the decision or migrate
  the routes; they currently disagree.

### Confirmed still missing

1. **Product URL import** — no code anywhere imports metadata/images from a
   pasted product link.
2. ~~Full narration generation~~ Built as part of the talking-head skill:
   `generate_narration` (orchestrator tool) → Cartesia `/v1/audio/speech`
   (inference gateway), including a `language` field for non-English reads.
3. ~~Presenter video~~ Built: per-clip silent video via `generate_video`,
   then lip-synced onto the locked narration track via `lipsync` (fal.ai
   LatentSync, or Sync Labs sync-2.0) — see the talking-head skill in
   `directorAgent.ts`.
4. ~~Script/shot-plan generation and final assembly~~ Assembly
   (concatenation to one MP4, aligned to the narration length) is built via
   `assemble_clips` (ffmpeg, local). Captions, music, and product-shot
   compositing beyond the talking-head flow are still unbuilt.
5. **Generation progress/regen/download/version-history UI** — not found in
   `apps/web`.
6. **Video generation has no async job layer.** `generate_video` is
   synchronous today, unlike the Phase 2 plan below. Fine for short
   `gemini-omni` clips; will need the SQS/watchdog bridge once a
   longer-running model (Veo, Seedance-class) is added.
7. **Creative-brief harness exists but live-run status is unverified from
   code alone.** `scripts/testCreativeBrief.ts` and `scripts/testDirector.ts`
   are real, runnable harnesses (Olmo → director delegate → `generate_image`,
   asserting a `fileId` comes back) — whether someone has actually run one
   against the live orchestrator and gotten a real image back needs a live
   check, not a code read.

### Known issues — re-verified today, both still open

**`fileIngest.ts` still crashes on a null uploader**, unfixed —
`products/agent-platform/packages/worker-handlers/handlers/fileIngest.ts:61`
still does `eq(users.id, fileRecord.uploadedBy ?? '')` against a `uuid`
column. Still unreachable in practice (every upload stamps a real user id)
but still a live landmine once anything writes a null-uploader `files` row.

**No internal file route for pure service-key callers** — confirmed,
`apps/api/src/app.ts` only mounts `/internal/integrations` under
`internalApi`. This does **not** currently block `generate_image`/
`generate_video`, since those forward the real user's `idToken` from chat
context rather than authenticating as the orchestrator's service key. It
would block generation triggered from an unattended async task (no user
token in scope) or from Drive — neither exists yet, so this is scoped risk,
not a live bug.

## Creative library handoff — 2026-09-15

The first creative-library milestone adds optional Templates, Avatars,
Products, and Audio selections to Olmo's free-text composer. Selections persist as a draft,
render as visual pills in the composer and sent message, and reach the agent as
a structured creative brief. Preset and uploaded assets, hover previews,
multilingual Cartesia voice previews, and the new-conversation handoff are
covered. At the latest checkpoint, the web suite passed 337 tests, TypeScript,
the production build, and an independent Astra review.

The remaining product work is the production pipeline:

1. Import product metadata and images from pasted product URLs.
2. ~~Generate full narration with the selected voice and language.~~ Built as
   part of the talking-head skill: `generate_narration` (orchestrator tool) →
   Cartesia `/v1/audio/speech` (inference gateway), including a `language`
   field for non-English reads.
3. ~~Turn the selected avatar reference and narration into presenter video.~~
   Built: per-clip silent video via `generate_video`, then lip-synced onto the
   locked narration track via `lipsync` (fal.ai LatentSync, or Sync Labs
   sync-2.0) — see the talking-head skill in `directorAgent.ts`.
4. ~~Generate the script and shot plan, render scenes, and assemble narration,
   captions, music, product shots, and transitions into a final MP4.~~
   Assembly (concatenation to one MP4, aligned to the narration length) is
   built via `assemble_clips` (ffmpeg, local). Captions, music, and product-shot
   compositing beyond the talking-head flow are still unbuilt.
5. Add generation progress, preview, regeneration, download, and version
   history UI.
6. Configure production provider credentials, credits, limits, retries, and
   generation pricing.
7. Run the creative-brief harness against the live orchestrator and verify one
   complete real generation.

The next milestone should be one vertical slice: submit a creative brief,
generate its script and storyboard, and render one real keyframe. This proves
the orchestration and asset path before implementing full video assembly.

**Media-generation status: partially built.** Image generation, video
generation (sync), song generation, video analysis, native approval-gated
credit spend, and the talking-head skill's narration/lip-sync/assembly
pipeline are real and shipped. Product import, captions/music/product-shot
compositing beyond the talking-head flow, and progress/version UI are not.
See "Status — verified against code" above for the accurate breakdown; the
rest of this document is design framing and settled decisions for what's
still ahead.

## What this platform is

This is not a software engineering platform. The agents are a creative and
content production crew, and the roster that exists today reflects that:

| Agent | Produces |
|---|---|
| Film-Production-Director | Shot lists, treatments, production direction |
| Professional-Video-Editor | Cut plans, edit direction, sequencing |
| Music-Video-Director | Concept and direction for music video work |
| PPT-Design-Expert | Decks and presentation design |
| Voice-Actor | Voice and read direction |
| Music-Producer | Music direction and production notes |
| Trend-To-Post | Turns a live trend into publishable posts |
| Viral-Content-Reproducer | Reworks proven content into new variants |
| Account-Monitoring | Watches account performance and surfaces signal |

Every one of these agents has an output that is fundamentally visual or
audible. Today they can only describe that output in text. The gap this
workstream closes is letting them produce the artifact itself.

## Where the gap is today

**Outdated — see "Status — verified against code" at the top.** This section
originally said "no generation path anywhere in the repository," which was
true when written and is no longer true. `generate_image`, `edit_image`,
`generate_video` (sync), and `generate_song` are real, shipped tools with
provenance (`files` rows via the normal upload path) and credit accounting.
The real remaining gap is narrower: no async video job layer, no
script/shot-plan/assembly layer, no product import, no presenter video, no
progress UI. Kept below for the historical framing of *why* image-first was
chosen, which still holds.

## Planned sequence

**Phase 1 — image generation. Shipped.** `generate_image` backed by
`gemini-3-pro-image-preview`, reachable through the inference gateway,
synchronous. Done, not planned — see "Status" above.

**Phase 2 — video generation.** Text-to-video via Veo, and later other
vendors. Video is a long-running operation measured in minutes, so it should
run on the async task queue with the watchdog and refund path that already
exist for agent tasks. **Partially true today**: `generate_video` exists and
ships, but it's synchronous against `gemini-omni-1.1-flash`, not yet bridged
to the async SQS/watchdog layer this phase describes. That bridge is still
the open work for a longer-running model.

Image ships first because both phases need the identical downstream pipeline —
model output to S3, asset row, Drive, inline render in chat, credit debit — and
image is the half of that which can be built and demonstrated without the
async operation layer. Video then adds only the polling and job lifecycle
rather than being a retrofit onto an image-shaped system.

## Design decisions already settled

**Vendor neutrality is a requirement, not a nice-to-have.** OpenAI's Sora,
Runway, and Seedream are all candidates alongside Google's models. Vendor
specifics live behind adapters; nothing above the gateway knows which vendor
served a request.

**Superseded by shipped code.** This decision said one endpoint
(`POST /v1/generations`) with a discriminated envelope, on the reasoning that
sync-vs-async is a model property, not a modality-level split. What actually
shipped (`apps/inference-gateway/src/index.ts:466-486`) is three
modality-specific routes — `/v1/images/generations`, `/v1/music/generations`,
`/v1/video/generations` — each still synchronous today. Reversing that now
means migrating three working, tested tool integrations
(`generateImage.ts`, `generateSong.ts`, `generateVideo.ts`) for no behavior
change yet, since nothing async exists to prove the original envelope
argument. Decision: **keep the per-modality routes**, and revisit only when
Phase 2's async video model actually lands and needs a pending-operation
shape — if two of the three routes need a job-id envelope and one doesn't,
that's the moment to decide whether to unify or give async routes their own
envelope convention. Don't unify speculatively before that's known.

**Model ids are namespaced `vendor/model`.** For example
`google/gemini-3.1-flash-image`. Loose prefix matching collapses as soon as two
vendors ship similar names, or the same model is reachable both directly and
through OpenRouter. Namespacing also keeps credit rate subjects unambiguous.

**No cross-vendor substitution.** The existing chat fallback chain degrades
across providers, which is acceptable within one model family. It is not
acceptable here: a user who asked for Runway must never silently receive
Seedream output, because the look, the price, and the licensing terms on the
result all differ. Fallback within a chain is permitted only between alternate
credentials for the same model. A vendor being down is an error, not a
substitution.

**Vendor URIs are never stored as an asset location.** Several vendors return
signed URLs that expire. The gateway normalizes to bytes or a URI, and the
caller always persists to S3 before returning anything to the agent.

**Generated media are ordinary `files` rows.** They land in Drive, are
retrievable, and appear in the gallery, because all of that already works.
Distinguishing generated from uploaded assets is a provenance column, not a
parallel asset system.

**The orchestrator gains no new credentials.** It has no S3 client today and
should not get one. Generated bytes go through the same presign, upload, and
confirm path the browser uses, which is what makes storage quota, audit
entries, deduplication, and abandoned-upload reclaim apply for free.

**Restricted data classification hard-fails.** Requests marked restricted are
pinned to a local model so the data never leaves the host. No local model can
generate images or video, so on this path restricted classification must
return an explicit error. Falling through to a cloud vendor would be a
data-classification breach.

**Spend is charged before the vendor call.** Unlike chat, where token counts
only exist after the stream finishes, generation cost is known up front. The
charge therefore happens inside the credit spend under the account lock, which
closes the concurrency race that a separate balance check would reopen. A
failed vendor call is compensated by an idempotent refund.

## Verified provider facts

Checked against Google's documentation on 2026-08-31. Re-verify before
implementation; these models move quickly.

**Available model ids.** `gemini-3-pro-image` (Nano Banana Pro),
`gemini-3.1-flash-image` (Nano Banana 2), and `gemini-3.1-flash-lite-image`
(Nano Banana 2 Lite). The original `gemini-2.5-flash-image` is deprecated and
must not be used for new work.

**Imagen is no longer an option.** All Imagen models were shut down on
17 August 2026, with the Gemini image models as the documented migration
target. There is no second Google model family to fall back to.

**Image models are served from the global endpoint only.** They are not
available on regional endpoints. This is not merely a configuration value: the
existing URL construction interpolates the location into the hostname, which
does not produce a valid host for the global endpoint. The global endpoint
omits the regional hostname prefix and carries `global` as the location in the
path, so the request builder needs an explicit branch for it.

A consequence worth recording: requests to the global endpoint give no control
over which region performs the processing. Restricted-classification traffic
already hard-fails on this path, so there is no breach, but generated media
carries no data residency guarantee.

**Generation cost scales with output size.** Models emit 512, 1K, 2K, and 4K
images at materially different token costs. A single flat per-call credit rate
is therefore only correct if one output size is fixed. Phase 1 should pin a
single size; exposing multiple sizes later requires the size to become part of
the credit rate subject.

**Reference image limits, for the editing question below.** The Flash models
accept up to 10 object images and 4 character images; Pro accepts 6 object, 5
character, and 3 style references.

**Preview status is a risk.** The current Flash image model is still marked
Preview and is global-endpoint-only, which together mean no adjustable
production quota and no residency commitment. Weigh this before building
production dependencies on it.

## Open questions

These are unresolved and belong in the spec, not in code:

- Whether phase 1 includes editing an existing asset (passing a reference
  image in) or is text-to-image only.
- When generation requires explicit user confirmation, given that it spends
  credits and an agent in a loop could otherwise drain a balance.
- Whether generation is reachable only from chat, or also from Drive and from
  unattended async tasks.
- How many images a single call may produce, and what is charged when a batch
  partially fails.
- Whether generated assets count against the tenant storage quota, and what
  retention applies to generations nobody keeps.
- Whether generated media are labelled as AI-generated in the UI or in
  embedded metadata.
- Per-vendor commercial licensing and moderation differences, which matter
  because users ship this output commercially. This is a product and legal
  decision, not an architectural one.

## Known issues to fix as part of this work

**`fileIngest.ts` crashes on a null uploader.** The uploader lookup coerces a
null `uploaded_by` to an empty string and compares it against a `uuid` column,
which makes Postgres raise `invalid input syntax for type uuid: ""` rather than
returning no rows. The throw happens before the surrounding error handling, so
the file is never marked failed and the message ends up in the dead letter
queue. It is unreachable today because every upload stamps a real user id, and
generated assets will be the first rows with a null uploader. Automatic
ingestion is gated to document types so images will not trigger it on their
own, but the manual ingest action still reaches it.

**There is no internal file route.** The orchestrator authenticates with a
service key rather than a user token, and the internal route namespace
currently exposes only integrations. Presign and confirm endpoints for service
callers are new scope.
