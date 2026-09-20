# ugc-character skill — design

Date: 2026-09-20
Status: revised after two rounds of Opus review — pending user review

## Revision note (round 3)

A second review, specifically auditing round 2's own fixes for the same
failure mode being called out ("convert a requirement into a weaker one
and present it as if it still satisfies the original ask"), found round
2's own board-approval fix did exactly that: `allowMode: 'auto'` is not
a weaker mechanism, it is **not operable by Olmo at all** — a server-held
flag written only by a human clicking a UI toggle
(`apps/web/.../chat/page.tsx:146` → `PATCH /conversations/:id`), read
once per turn before the stream starts (`chatStream.ts:303`), with no
tool or agent-callable surface anywhere. Round 2's "toggle it on, toggle
it off after" board-approval design describes behavior the system cannot
produce. This round removes that mechanism entirely and states the real
v1 behavior plainly instead (see Phase 1 step 4 and Known Limits).

Also fixed this round: a false "no tool exists" justification for
dropping wordmark verification (an `analyze_image` tool is smaller than
other work already in Phase 0 — scoped in for real); a single-reference
constraint wrongly borrowed from the video path and applied to images
(the image gateway can already take N inline images — scoped in for
real); an unapproved paid retry that silently overrode an existing
credit-confirmation rule; a generation step ordered before its own
approval step; an unenforced "verbatim" identity rule with no code
backing it (same class of gap skill 1 already solved once for dialogue —
same fix applied here); and three wording inaccuracies (an unenforced
prompt instruction described as a "mechanism," an overstated redaction
risk, and a reference to the wrong existing code path as prior art).
Changed points are marked **[review-3]**; round 2's own markers are kept
as **[review-2]** where still accurate.

## Problem

`apps/agent-orchestrator` can clone an existing ad template
(`template-video-generation`, skill 1, shipped) but has no skill for the
other half of the video-ad pivot: build a UGC-style ad **from scratch**,
with no reference video to clone — cast a presenter, generate a
consistent multi-beat storyboard, and render each beat, entirely from a
product photo and a brief. This is skill 2 of 7 in the planned sequence.

This skill has real prerequisite gaps in the generation tools
themselves, the same shape as skill 1's Phase 0. `generate_video` already
supports `animate_frame`/`composite_references` modes (skill 1's Phase 0
landed), but:

1. **`generate_image` has no image-reference input at all.**
   `generateImage.ts`'s `inputSchema` is `z.object({ prompt: z.string() })`
   — that is the whole schema. **[review-3] Corrected — this is fixable
   with N references, not capped at one.** The prior round assumed
   `generate_image` shares `generate_video`'s single-reference-only
   limitation. It doesn't: the image gateway
   (`apps/inference-gateway/src/images.ts`) already builds a `parts`
   array and pushes inline image data into a multi-part Gemini request —
   the single-reference ceiling is a fact about `generate_video`'s Omni
   path specifically (one `imageUri` field), not a shared model
   constraint. Phase 0 adds a real array-based reference input here, not
   a single optional field.
2. **`generate_video` still only ever forwards the FIRST reference image**,
   regardless of how many are passed — this constraint is real and stays
   as documented in round 2 (`generateVideo.ts`: `referenceFileIds?.[0]`;
   Director's own shipped instructions already say so). A video call
   needing both a cast sheet and a product photo as separate anchors
   still cannot do both in one call — only the image path gains
   multi-reference support this round.
3. **No image-analysis tool exists.** **[review-3] Corrected — this is a
   scoping choice, not a hard blocker.** `analyzeVideo.ts` already posts
   an image array plus an arbitrary text prompt to the model and returns
   its answer; an `analyze_image(fileId, question)` tool is the same
   code path minus frame extraction — smaller than the reference-input
   work in gap 1, which this spec already scopes into Phase 0. Scoped in
   for real below, not deferred.
4. **No standalone voiceover/TTS tool.** Out of scope for v1 — see Scope.
5. **No logo/overlay compositor.** Out of scope for v1 — see Scope.

**Structural findings governing Phase 1's design:**

- **Delegate threads are memory-isolated from Olmo's thread.** Director
  delegations run on a fresh thread with a random UUID suffix, and
  `directorAgentDelegate` has no memory of its own. Anything Olmo
  "remembers" is invisible to Director unless restated verbatim inside
  the text of every delegation call.
- **Working memory already has a durable slot for this**:
  `# Active Job` → `Casting Choice` / `Locked Reference Artifact IDs`.
  **[review-3] Corrected reasoning for using it** — round 2 justified
  this partly by claiming a cast-sheet fileId quoted in Olmo's own reply
  text gets redacted before persistence. That's only true across turns;
  `redactUnverifiedFileIds` strips a UUID only if it's absent from that
  *same turn's* `pendingAttachments`, and a cast-sheet fileId generated
  in that turn is present there (delegate `subAgentToolResults` are
  unwrapped into `pendingAttachments` before the redaction check runs).
  The real reason to use working memory isn't redaction — it's that
  Mastra rewrites conversational text on every turn with no guarantee a
  specific fileId survives verbatim into a much later turn, while working
  memory is the one slot designed to persist structured facts across the
  whole conversation.
- **Board-level approval (N stills approved together, one cost-gated
  unit) is not achievable in v1 — see Phase 0 below.** This is stated
  plainly this round rather than routed around.
- **[review-3] "Verbatim, unreworded" identity tokens (terse tag,
  style-lock paragraph) need the same enforcement class as skill 1's
  dialogue gate, not a prose instruction.** Working memory is
  model-authored and rewritten every turn — the mechanism round 2 chose
  to "preserve" these strings verbatim is exactly the one thing
  guaranteed not to. Skill 1 already solved this exact problem once
  (`generateVideo.ts`'s `extractQuotedSpans`/`approvedDialogue`, built
  specifically because "instructions can't block a call; only code can" —
  see [[project_template_video_skill_design_notes]]). Same fix applied
  here in Phase 0.
- **`generate_video`'s three modes (`text_to_video` / `animate_frame` /
  `composite_references`) are mutually exclusive by schema.** "Omit the
  character reference for a b-roll beat" is a mode change, not a field
  drop.

## Research basis

Five independent production implementations read in full: Advibly's
`ugc-ads`, novoads' `clone-image-ad`, `image-to-motion`, `pixar-ad`, and
`clone-video-ad`. Full findings: [[project_ugc_character_skill_notes]],
[[project_advibly_skills_notes]].

## Scope

**Phase 0 (prerequisite, this spec, build first):**
- Add an array-based reference-image input to `generate_image` (real
  multi-reference support — see below).
- Add a new `analyze_image(fileId, question)` tool.
- Add tool-code enforcement of the terse tag / style-lock paragraph,
  matching the dialogue gate's pattern.
- No new schema. Use the existing `Locked Reference Artifact IDs` /
  `Casting Choice` working-memory fields for cast-sheet persistence
  across Olmo's own turns.
- **No board-approval-batching work in this skill.** [review-3] A real
  fix exists — `chatStream.ts`'s turn loop drops any additional pending
  `tool-call-approval` chunk on resume instead of queuing it, which is
  what actually blocks batched approval (not a missing Mastra feature).
  Fixing that is shared infra used by every generation tool, not scoped
  to this skill — tracked as a separate, deferred infra item, not
  silently routed around here. See Phase 1 step 4 for v1's real,
  unbatched behavior.

**Phase 1 (this spec, ships after Phase 0):**
The `ugc-character` skill itself.

**Explicitly out of scope for this spec** (tracked separately, not
blocking v1):
- A persistent, cross-session, browsable avatar/character library.
  Deferred-library note: belongs in
  `products/agent-platform/packages/schema/`, never
  `packages/foundation/database/schema/`.
- Multi-clip assembly/stitching into one final ad — deferred to
  `short-drama-stitch` (skill 7).
- External voiceover generation — no tool exists.
- The logo-compositing fallback tier of wordmark handling — no
  compositor exists (the *verification* tier is scoped in this round,
  only the *composite-a-clean-logo-after-repeated-failures* tier stays
  deferred).
- **Batched/board-scoped approval in `chatStream.ts`** — real, buildable,
  shared-infra fix, explicitly named as deferred rather than routed
  around with a mechanism that doesn't work (see Phase 0 note above).

## Phase 0: prerequisite tool work

### `generate_image` gains real multi-reference support

```ts
inputSchema: z.object({
  prompt: z.string(),
  referenceFileIds: z.array(z.string()).min(1).max(3).optional().describe(
    'Existing files rows used as identity/style anchors — the model composes a new image informed by all of them.'
  ),
  identityAnchor: z.object({
    terseTag: z.string(),
    styleLock: z.string(),
  }).optional().describe(
    'When set, the prompt MUST contain both strings verbatim — enforced in code, not by instruction. Required whenever referenceFileIds includes a cast sheet.'
  ),
})
```

**[review-3]** Wires all provided reference file ids into the gateway's
existing multi-part request shape (`images.ts`'s `parts` array already
supports this — extend its request type from a single
`sourceImageBase64` scalar to an array, one inline-data part per
resolved reference). This is the real fix for the "cast sheet + product
photo, one call" case round 2 gave up on.

**`identityAnchor` enforcement, matching skill 1's dialogue gate
pattern:** before calling the gateway, the tool checks `prompt.includes(terseTag)
&& prompt.includes(styleLock)` when `identityAnchor` is set, and refuses
(`IDENTITY_ANCHOR_MISSING`, no charge) if either is absent — the same
"refuse before any charge, in tool code, not prose" shape as
`extractQuotedSpans`. `generate_video` gains the same optional
`identityAnchor` field and check for on-camera beat renders.

### `analyze_image` — new tool

Same shape as `analyzeVideo.ts` minus frame extraction: takes a fileId
and a question, posts the image plus the question to the model, returns
its answer as text. Used for wordmark verification (Phase 1 step 3):
"does this image spell {brand} correctly — answer yes or a corrected
spelling."

## Phase 1: the `ugc-character` skill

### Architecture

Same split as skill 1: Olmo carries the conversation; Director executes
generation, delegated to, once per delegation per `DELEGATION_CONTRACT`
(Director may loop N tool calls inside one delegation — that's internal
tool use, not a parallel-delegation violation).

### Conversational flow

1. **Intake** (Olmo). Product photo (three-tier fallback: real photo →
   generated still → text-only with an explicit caveat). Brief: vibe,
   audience, beat count, variation count — asked before any pricing
   estimate.
2. **Cast sheet generation** (Director, delegated). One `generate_image`
   call with `referenceFileIds: [productPhotoFileId]` (now real, per
   Phase 0) producing one frame: presenter in 3 emotional states +
   product views + a scale line-up. Olmo writes the resulting fileId into
   working memory's `Locked Reference Artifact IDs`, and derives + stores
   there a **terse tag** (10-40 characters, wardrobe-anchored, e.g. "the
   woman in the yellow cardigan") and a **style-lock paragraph** (palette,
   light source, lens, finish) — both now enforced verbatim by Phase 0's
   `identityAnchor` check on every later call, not just instructed.
3. **Per-beat mode table + stills** (Director, delegated):

   | Beat type | Still generation | Video mode |
   |---|---|---|
   | On-camera | `generate_image` with `referenceFileIds: [castSheet]`, `identityAnchor` set | `animate_frame` off the approved still |
   | B-roll | `edit_image` on the real product photo, or `generate_image` with no reference | `animate_frame` off the approved still — never `composite_references` with the cast sheet |

   Frame prompts end on a paused-frame-quality closer, written unquoted
   (the dialogue gate refuses any quoted span with no approved line,
   which is the normal case for silent b-roll beats). **Wordmark
   handling, now the full pattern**: spell the brand name letter-by-letter
   in the prompt; call `analyze_image` against the render to check it; on
   a mismatch, tell the user plainly and **ask for fresh approval before
   any retry** — [review-3] a retry is a new paid generation, and
   `COST_CONFIRMATION_CONTRACT` already forbids regenerating to fix a bad
   result without a fresh confirmation. No silent auto-retry.

   **[review-3] Real v1 behavior, stated plainly, no substitute
   mechanism:** each `generate_image`/`generate_video` call in this loop
   independently triggers its own `requireApproval` cost card — an
   N-beat board means N sequential blocking cost cards during stills, and
   N more during video rendering later. There is no way to batch these
   today (see Phase 0's deferred-infra note). Olmo's plan message before
   this step should say so honestly: "I'll generate N stills — you'll see
   a cost confirmation for each one."

4. **Board review** (Olmo). **[review-3] Reordered and re-scoped — this
   is a continuity review of the actual rendered stills, not a cost
   estimate, and it happens AFTER stills exist, not before.** Once all N
   stills from step 3 are generated (and individually cost-approved per
   above), Olmo presents them together and asks the user to approve the
   board as a set — judging beat-to-beat continuity, per the pixar-ad
   finding this step exists to satisfy. Only stills the user accepts here
   proceed to step 5; a rejected still is regenerated (itself a fresh
   cost-gated call, itself the same "ask before retry" rule as above).
5. **Per-beat video render** (Director, delegated). `animate_frame` off
   each board-approved still. Realism-forcing modifiers, written
   unquoted. One simple action per shot. Native speech OR silence per
   beat (VO out of scope for v1). Native-speech beats use skill 1's
   existing content gate unchanged.
6. **Post-generation QA** (Director, delegated). **[review-3] Restated
   accurately** — this is a Director instruction (`directorAgent.ts`'s
   existing bullet), the same prompt-level mechanism as skill 1 uses
   today, not a code-enforced check. Nothing blocks delivery on a
   mismatch; it relies on Director following the instruction, same as
   skill 1's shipped behavior.
7. **Deliver** (Olmo). Present each clip separately. State plainly that
   beats aren't assembled into one ad, and the character persists only in
   this conversation's working memory.

### Known limits, stated plainly

- **No board-scoped or batched cost approval exists.** Each still and
  each video render pops its own cost card — an N-beat board is N+N
  sequential approvals, not one. The real fix (queue multiple pending
  `tool-call-approval` chunks in `chatStream.ts`'s turn loop instead of
  dropping them) is buildable but is shared infra affecting every
  generation tool, deliberately not scoped into this skill.
- Character/cast sheet persists only in this conversation's working
  memory.
- No VO-based beats.
- No multi-clip assembly.
- Wordmark verification is real (Phase 0's `analyze_image`) but the
  composite-a-clean-logo fallback tier is not — a confirmed-wrong render
  after one user-approved retry is surfaced to the user, not auto-fixed.
- Post-generation transcript QA is a Director instruction, not a
  code-enforced check (matches skill 1's current shipped behavior,
  named accurately rather than implied to be stronger).

## Open questions

- Beat count ceiling — needs a real number, now directly affecting how
  many sequential cost cards a user sees per board; worth surfacing to
  product/design given the UX cost is real and visible per this spec.
- Whether to prioritize the `chatStream.ts` batched-approval fix ahead of
  this skill's implementation, given it directly improves this skill's
  weakest known limit — a real scheduling question, not a design one.

## Next step

Hand to the writing-plans skill for an implementation plan, Phase 0
first (multi-reference `generate_image`, `analyze_image`, identity-anchor
enforcement) before Phase 1.
