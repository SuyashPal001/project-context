# Template recreation-contract design

Date: 2026-09-16
Status: revised after Opus review — pending implementation plan

## Revision note (post-review)

An independent review against the actual runtime found two blockers in the
first draft (wrong agent instance, wrong tenant-scoping precedent) plus a
materially understated Phase 2 and several smaller gaps. This version folds
in every fix. See inline notes marked **[review]** at each changed point.

## Problem

The media-generation creative library ships six templates
(`apps/web/components/platform/chat/creativeLibraryTemplates.ts`), each just
an id, title, category, image, description, and one flat free-text `prompt`
string. When a user picks one, the full prompt string is baked directly into
the chat message client-side (`creativeBrief.ts`'s `buildCreativeBriefMessage`)
and the director agent reads it as ordinary text.

This gives the agent a structural genre hint ("use a Product Demo ad
structure") but nothing resembling the recreation-contract pattern this
product needs: no per-scene timing, no keep-vs-exclude split, no technical
constraints (aspect ratio/duration/fps), and no connection to an actual
reference ad clip to clone. It is the single largest gap between what exists
today and the "clone this specific ad" product goal.

## Scope

**Phase 1 (this spec, build now):**
- New DB table holding a richer, structured contract per template.
- Seed script populating the current 6 templates with full hand-authored
  contracts, including a scene-by-scene breakdown.
- A `retrieve_template(id)` Mastra tool registered on **both**
  `directorAgent` and `directorAgentDelegate`
  (`apps/agent-orchestrator/src/mastra/agents/directorAgent.ts`) that fetches
  the contract server-side. **[review]** The production brief path is
  Olmo → `directorAgentDelegate`, not `directorAgent` — the two are separate
  `Agent` instances with independently-declared `tools:` maps, and only
  registering on `directorAgent` would ship a tool nothing in the live path
  ever calls. Both instances share `directorInstructions`, so the prompt
  change below applies to both automatically.
- `directorInstructions`'s shared default-instructions block updated to call
  `retrieve_template` before acting on a templated brief.
- Web changes: template catalog trimmed to display-only fields; the chat
  message carries the template id, not the full prompt text.

**Phase 2 (same spec, ships immediately after Phase 1, not deferred
indefinitely):**

**[review] Rewritten — the first draft's "run analyze_video and UPDATE the
row" undersold this by four separate pieces of real work:**

1. **New structured analysis mode.** `analyzeVideo.ts` today returns free
   prose from two hardcoded prompts ("brief 1-2 sentence summary" / "detailed
   description") with no response schema — nothing produces
   `Array<{order, shotType, action, onScreenText?, audio?}>`. Phase 2 needs a
   new analysis mode with a structured-output schema, not a reuse of the
   existing quick/deep modes as-is.
2. **Scene-boundary detection.** The tool samples 8 or 20 frames at a
   uniform interval (`media.ts`) — uniform sampling cannot locate scene cuts
   or per-scene timing, which is the entire point of `scenes[]`. `ffprobe`
   already computes `duration` in `media.ts` but discards it, so even
   `technical.durationSeconds` isn't populated by the tool as it exists
   today; wiring that through is in scope, real scene-cut detection is a
   separate, harder problem that may need its own approach (e.g. shot-boundary
   detection before frame sampling, not just denser sampling).
3. **Audio join.** `scenes[].audio` and `clone_notes`'s "pacing, audio,
   feel" are unreachable from `analyze_video`, which is video-frames-only.
   `analyzeAudio.ts` is a separate tool; Phase 2 needs to join its output in,
   not assume video analysis covers it.
4. **No-session, no-tenant-file problem.** `analyzeVideo.ts` requires a
   tenant-scoped `fileId` plus a live `idToken`/`sessionId` (returns
   `no_active_session` otherwise). A curated *global* reference clip run
   from a seeding script has neither. Either upload each clip into a fixture
   tenant first, or give the analysis path a service-key route — which
   circles back to this doc's own "no internal file route for pure
   service-key callers" gap, still open.
- Once those four exist, the mechanical part holds: run analysis per clip,
  write `scenes`/`technical`/`reference_video_url` into the row,
  `retrieve_template`'s contract shape and director's usage don't change.

**[review] Honesty check:** even with Phase 2 done, nothing in
`generate_image`/`generate_video` currently consumes `scenes[]`/`technical{}`
— `generateVideo.ts` takes only `{ prompt: string }`. Per
`docs/media-generation/README.md`'s own "confirmed still missing" list, no
shot-plan or scene-assembly layer exists yet. Phase 1 and 2 therefore ship
contract *data* as groundwork; a template's `scenes[]` stays inert until a
later, separate piece of work teaches a generation tool to read it. This
spec does not claim otherwise, and neither phase should be read as making
template cloning operative end-to-end by itself.

**Explicitly out of scope for both phases:**
- Tenant-authored templates (paste-your-own-competitor-ad). Global template
  library only, curated centrally.
- Any change to `generate_image`/`edit_image`/`generate_video` themselves.
- Any change to the approval-gate or credit-charging mechanics already
  shipped for those tools.

## Data model

New table `creative_templates` in
`products/agent-platform/packages/schema` (agent-platform domain, alongside
`skills.ts`/`personas.ts` — not `packages/foundation/*`, since this is
project-context-specific creative-production data, not a generic SaaS
concern).

```
creative_templates
  id                   uuid PK, default random
  tenant_id            uuid, nullable, references tenants.id
  slug                 text
  title                text
  category             text
  description          text                  -- picker card blurb
  image_url            text                  -- illustrative still (today's /creative/templates/*.png)
  reference_file_id    uuid, nullable, references files.id  -- populated in Phase 2 only
  clone_prompt         text
  negative_prompt      text
  clone_notes          text                  -- what MUST be preserved (pacing, audio, feel)
  exclude_in_clone     text                  -- what MUST be replaced/omitted
  technical            jsonb                 -- { aspectRatio, durationSeconds, resolution, fps }
  scenes               jsonb                 -- Array<{ order, shotType, action, onScreenText?, audio? }>
  status               text, default 'active' -- 'active' | 'archived'; lets a row retire without breaking historical transcript references to its slug
  created_at           timestamp
  updated_at           timestamp, $onUpdate

  unique(tenant_id, slug)
```

**[review] `tenant_id` is nullable, not absent.** The first draft cited
`skills.ts` as precedent, which is wrong — `skills.ts` is tenant-scoped
(`ownerTenantId NOT NULL`). The correct precedent, in the same package, is
`agentTemplates` (`agents.ts`): `tenantId` nullable, with the column comment
"NULL = platform-owned, following the convention `agent_tools` already
uses." That table was built for exactly this shape — a platform-curated row
today, a tenant-owned row later. Following it now costs one nullable column
and makes `unique(tenant_id, slug)` the natural key; not following it means
a migration plus a uniqueness-semantics change the day tenant-authored
templates (explicitly on this product's roadmap, just not this phase) land.
All Phase 1 rows have `tenant_id = NULL`.

**`production_guide` cut.** **[review]** The first draft copied this field
from the source blueprint along with its surrounding machinery ("skips fresh
analysis") — machinery this spec doesn't build. No consumer is defined for
it here; re-add only if and when something actually reads it.

**`reference_file_id` replaces `reference_video_url`.** **[review]** A free
URL conflicts with this doc's own settled decisions ("Vendor URIs are never
stored as an asset location," "Generated media are ordinary `files` rows").
A curated reference clip should be an uploaded `files` row like everything
else this product stores, not a raw link — both for the expiring-URL reason
already on record and because these are (likely competitor) ad clips with a
licensing question nobody has resolved yet. That resolution is Phase 2's
problem, not this schema's; the column just needs to point at the right kind
of thing.

Convention otherwise follows `skills.ts`/`agentTemplates`: typed columns for
scalar fields, `jsonb` for variable/nested shapes (`technical`, `scenes`) —
same pattern as `creditRates.pricingSchema`. `reference_file_id` and the
jsonb columns exist from Phase 1 so Phase 2 needs no migration, only an
UPDATE (once its file-ingestion path exists — see Phase 2 above).

## Tool contract

```
retrieve_template(slug: string) →
  {
    slug, title, category,
    clonePrompt, negativePrompt, cloneNotes, excludeInClone,
    technical, scenes, referenceFileId,
  }
  | { found: false }
```

- Registered on **both** `directorAgent` and `directorAgentDelegate` — see
  Scope above.
- **Free** — no `requireApproval`, no credit charge. **[review, confirmed
  correct]** Checked `shouldRequireApproval`: it's a no-op unless
  `resolveRate(resourceType, subject)` returns a rate, and every currently
  gated tool (`generateImage.ts`, `generateVideo.ts`) gates because it spends
  credits before a vendor call. `retrieve_template` spends nothing and reads
  Postgres directly (same shape as `fetchPRD.ts`/`fetchPlan.ts`), so leaving
  it ungated is consistent with the existing pattern, not an exception to
  it. Because rows can be tenant-owned later, the query must filter
  `tenant_id IS NULL OR tenant_id = :ctxTenantId` even though every row is
  global today.
- Directors' shared default instructions call `retrieve_template` first
  whenever the incoming brief carries a template slug, before any generation
  tool call, and use the returned contract (not a client-supplied prompt
  string) as the source of truth for structure, scenes, and technical
  constraints. **[review]** The instructions must also cover the not-found
  case explicitly — `directorInstructions` today enumerates a handler for
  every `refusalReason` a generation tool can return; `retrieve_template`
  needs the same discipline (`{ found: false }` → tell the user the template
  couldn't be found, do not invent a structure) or the model will hallucinate
  scenes when a slug is stale or wrong.
- **[review]** `directorInstructions` builds from
  `requestContext?.get('agentSystemPrompt')` when a tenant has set a custom
  agent system prompt, which *replaces* the default block entirely rather
  than extending it. A tenant with a custom Director prompt will not get the
  `retrieve_template` instruction. This spec accepts that as existing,
  intentional per-agent override behavior (same as every other default-prompt
  rule already in that file) rather than special-casing this one addition —
  noted here so it isn't mistaken for an oversight.

## Web / client changes

- `creativeLibraryTemplates.ts` (or its DB-backed replacement — see Open
  question below) keeps only what the picker card needs: `id`/`slug`,
  `title`, `category`, `description`, `image`. Drops `prompt`.
- `creativeBriefModel.ts`'s `CreativeBrief['template']` shape drops `prompt`;
  keeps `id`/`title`/`category`/`image` for display purposes only.
- `creativeBrief.ts`'s `buildCreativeBriefMessage` stops interpolating
  `brief.template.prompt` into the message text. It sends the template
  reference (id + display label) in the structured brief section; the full
  contract is never present client-side or in the chat transcript text —
  only director's tool call result carries it, server-side.
- **[review] `isTemplateSelection` in `creativeBrief.ts` must change, and
  carefully.** It currently hard-requires `hasString(value, 'prompt')`. This
  predicate runs on two different things: validating a *new* draft, and
  `parseCreativeBriefPresentation` re-parsing the `<!-- olmo-creative-brief:v1:
  -->` annotation out of **already-sent historical chat messages**. Those
  historical messages still carry `prompt` in their persisted JSON. So the
  predicate must accept a `template` value whether or not `prompt` is
  present — not simply drop the field from the required-keys check, or
  every past templated message stops rendering in the transcript the moment
  this ships. New drafts stop producing `prompt`; the predicate stays
  backward-compatible with rows that have it.
- `creativeMessageDisplayText`/`creativeSelectionLabel` need no change — they
  already only use `title`/`category`, not `prompt`.
- `CreativeLibrary.tsx` spreads `{ kind: 'template', ...template }` into the
  selection object, which currently leaks `description` even though
  `TemplateSelection` doesn't declare it. **[review]** Worth tightening to an
  explicit field list while touching this code, not a separate task.

## Migration path for Phase 2

Because `reference_file_id`, `scenes`, and `technical` already exist as
columns from Phase 1, Phase 2's schema-level change is data-only: once the
four real pieces of Phase 2 work above exist, a script does an
`UPDATE creative_templates SET scenes = ..., technical = ...,
reference_file_id = ... WHERE slug = ...`. `retrieve_template` and every
consumer of its output are unchanged. This is the reason the schema is
designed this way now rather than adding these columns later.

## Implementation gotchas

**[review] Added — mechanical details the first draft missed:**

- **Migration location.** New table's migration goes in
  `packages/foundation/database/migrations/` (drizzle-kit's single `out`
  directory for both schema barrels per `drizzle.config.ts`), *not* under
  `products/`. The schema *definition* file still lives under
  `products/agent-platform/packages/schema/` — only the generated SQL lands
  in the shared foundation migrations directory. Someone following CLAUDE.md's
  foundation/product split will otherwise look for the migration in the
  wrong place.
- **Barrel export required.** The new schema file must be exported from
  `products/agent-platform/packages/schema/index.ts` or `drizzle-kit
  generate` emits nothing for it.
- **Seed script location and idempotency.** Product seeds live in
  `products/agent-platform/packages/api/seeds/`, invoked by per-seed npm
  scripts (e.g. `db:seed:templates` already means `agent-templates.ts` for
  the *agent* template system — name this one distinctly, e.g.
  `db:seed:creative-templates`, to avoid confusion with that existing,
  unrelated table). Make the seed idempotent (`onConflictDoUpdate` on
  `(tenant_id, slug)`) since it will be re-run every time a contract is
  hand-edited during Phase 1 authoring.
- **Name collision risk.** `agent_templates` (agents.ts) already exists as a
  distinct, unrelated concept (versioned agent system prompts). Comment the
  new table clearly so the two aren't conflated by a future reader.

## Testing

- Seed script populates all 6 templates; a test asserts every row parses
  against the expected shape (non-empty `scenes` array, valid `technical`
  keys).
- `retrieve_template` tool test: given a known slug, returns the expected
  contract shape; given an unknown slug, returns `{ found: false }` (never
  throws into the agent loop).
- Director harness-style test (extending the existing
  `scripts/testDirector.ts` pattern): brief with a template slug → asserts
  `retrieve_template` is called before any `generate_image`/`generate_video`
  call. Run against both `directorAgent` and `directorAgentDelegate` paths.
- Web: **[review] corrected list** — `prompt` currently appears in five
  files, not two: `creativeBrief.test.ts`, `CreativeBriefChips.test.tsx`,
  `MessageItemCreativeBrief.test.tsx`, `useCreativeBriefDraft.test.tsx`, and
  `CreativeLibrary.test.tsx` (which asserts on the prompt *content* directly
  — `expect.stringContaining('Do not invent customer quotes')`). All five
  need updating for the trimmed `template` shape.
- **[review] New, the single most likely regression:** a test asserting that
  a *historical* transcript message — persisted JSON still containing
  `prompt` — still parses and renders correctly through
  `parseCreativeBriefPresentation` after the type change. This is the
  backward-compatibility case the `isTemplateSelection` change above exists
  to protect, and nothing else in this test list would catch a regression
  there.

## Open questions (resolved before implementation, not blocking this spec)

- Does the web picker's card data (title/category/description/image) also
  move into the DB table, or stay as static `creativeLibraryTemplates.ts`
  reading only display fields while the full contract lives server-side in
  `creative_templates`? Leaning toward keeping picker display data static
  (matches how avatars/voices are handled today) and having only the
  contract live in the new table — decide at implementation-plan time, not
  a design blocker.
- Exact `scenes[]` field shape (`shotType` enum vs free text) — pin down
  during implementation once the 6 templates are actually being hand-authored
  and real examples surface what's needed.
- Phase 2's clip-sourcing/licensing question (where do real reference clips
  come from, what's the rights basis) is explicitly not resolved here —
  flagged in the Phase 2 section, decided at that phase's kickoff.
