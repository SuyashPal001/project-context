# template-video-generation skill — design

Date: 2026-09-18
Status: revised after two rounds of Opus review — pending user review

## Revision note (round 2)

A second independent review, verifying the first round's fixes against
live code rather than trusting the fix descriptions, found the first
revision's Phase 0.5 "option B" (prove this skill's generation calls run
at `delegationDepth === 0`) is **impossible, not just unverified**:
`platformAgent.ts`'s `SERVER_TOOLS` (Olmo's own tool set) contains no
`generate_image`/`generate_video` at all — generation is reachable **only**
through `directorAgentDelegate`, always at depth ≥ 1. So the approval card
does not "sometimes get bypassed" — it **never fires for video generation
today, full stop**. It also found the chosen Phase 1 architecture (put
everything in Director) cannot carry a multi-turn conversation, since
Director is a one-shot delegate with no memory and no dialogue/gate tools;
found the per-tenant `agentSystemPrompt` override would silently delete
any skill instructions appended the way the first revision proposed;
found the model-id migration checklist was still missing two real sites;
and found the proposed job-id derivation reads a field from the wrong
object and has a real charge-suppression bug on retry. This version folds
in all of it. Changed points are marked **[review-2]**.

## Problem

`apps/agent-orchestrator` has generic creative infrastructure
(`retrieve_template`, `generate_image`, `edit_image`, `generate_video`,
`generate_song`, `analyze_video`, `analyze_audio`, `generationApproval.ts`'s
credit gate) but no actual skill that turns "clone this ad for my product"
into a finished video. This is the first of 7 planned creative skills for
`apps/agent-orchestrator`'s video-ad pivot. It is the one to build first
because `retrieve_template` and the credit-gate pattern already exist to
build on.

Three prerequisite gaps block a real (not text-only, not silently
ungated) version of this skill:

1. **`generate_video` is text-only.** Neither the Gemini Omni Interactions
   path nor the Vertex Veo fallback in `apps/inference-gateway/src/video.ts`
   sends an image. Without image-conditioning, "clone with your product"
   degrades to "AI video loosely inspired by a text description of your
   product" — the core promise of the skill.
2. **No capability-based generation planner exists, and the current code
   does the specific thing `docs/media-generation/README.md` forbids.**
   `video.ts:157-197`'s `generateVideo()`: with `GEMINI_API_KEY` unset, or
   its circuit breaker open, every request goes to Vertex Veo
   (`callVertexVeoModel`, model `veo-2.0-generate-001` — the surrounding
   comment says "Veo 3", which is wrong) instead of Gemini Omni, provided
   `vertexVideoBreaker` is available and `VERTEX_PROJECT` is configured; on
   a Gemini failure it falls back the same way. Either way this is silent
   cross-vendor substitution — a different model, with nothing in the tool
   result telling the caller which one actually ran.
   `docs/media-generation/README.md` settles that this is forbidden: "no
   cross-vendor substitution... a vendor being down is an error, not a
   substitution."
3. **[review-2 — corrected, more severe than previously stated] Video
   generation has no approval gate at all today, for anyone.**
   `platformAgent.ts`'s `SERVER_TOOLS` (Olmo's own tools) does not include
   `generate_image` or `generate_video` — those exist only on
   `directorAgent`/`directorAgentDelegate`, and every real chat path reaches
   them through `directorAgentDelegate` (Olmo delegates to Director).
   `generationApproval.ts`'s `shouldRequireApproval` returns `false`
   whenever `delegationDepth > 0` (confirmed at the source: this bypass
   exists because Mastra's `approveToolCall` cannot resume a delegate's
   suspended tool call in the installed version — see
   `project_delegate_network_migration` project memory, already tracked,
   not discovered by this spec). Since delegate calls are the *only* path
   to video generation, **the cost gate is not "sometimes skipped" — it
   never runs for video today.** There is no alternate direct path to
   route around this: registering `generate_video` directly on Olmo would
   contradict the existing `ROUTING_CONTRACT`/`DELEGATE_MEDIA` design
   (media generation is deliberately Director's job, not Olmo's).

This spec covers gaps 1 and 2. Gap 3 is named as a hard, unconditional
blocking dependency — see Phase 0.5 — with no workaround available inside
this skill's own scope.

## Research basis

Four independent production implementations were read in full (or by a
deep sub-review) before this design: ByteDance's open-source
`byted-bp-seedance-viral-creative-rewrite-skill`, Google's own open-source
"Scene Machine" tool (uses our exact same models — Gemini Omni Flash and
Vertex Veo), competitor Novoads' `clone-video-ad` skill (BytePlus Seedance),
and competitor Advibly's `ugc-ads`/`video-restyle` skills (Gemini Omni
Flash). Findings are cross-validated across all four unless noted, and one
correction was caught mid-research (video-to-video *edit* exists on Omni via
`task: 'edit'`; video-to-video *reference-for-new-generation* does not exist
on any of the four). Full findings live in project memory, not repeated here
in full.

## Scope

**Phase 0 (prerequisite, this spec, build first):**
Image-conditioning + planner interface on `generate_video`. Fixes the
cross-vendor-substitution bug.

**Phase 0.5 (prerequisite, hard blocker, no workaround inside this
spec's scope):**
**[review-2] Resolve `project_delegate_network_migration` — full stop.**
There is no "or" option. Video generation is Director-only, Director is
always called at `delegationDepth ≥ 1`, and the approval bypass at that
depth is unconditional. Phase 1 cannot ship — at any scope, with any
workflow — without this migration landing first, because it would mean
real, unbounded credit spend with no cost gate and no content gate.
This is an explicit dependency on a separate, already-tracked piece of
work, not something this spec's implementation plan can complete itself.

**Phase 1 (this spec, ships only after Phase 0 and Phase 0.5 are both
done):**
The `template-video-generation` skill itself.

**Explicitly out of scope for this spec** (tracked separately, not
blocking): async job layer bridging to the SQS/watchdog task-refund
infrastructure; Wan Animate integration; avatar/casting library; multi-clip
assembly and voice/audio stages (deferred to `short-drama-stitch`).

## Phase 0: `generate_video` image-conditioning + planner interface

### What changes

**`generate_video`'s input schema gains explicit generation-mode fields.**
**[review-2] Changed from a `z.discriminatedUnion` to a flat `z.object`
with a `mode` enum plus optional fields, refined at runtime** — a
discriminated union compiles to `anyOf` in the JSON Schema sent to
Gemini/Vertex as a function declaration, and every existing tool in this
codebase uses a flat `z.object` for exactly this reason (untested whether
these models handle `anyOf` function-call schemas well; not worth being
the first tool to find out):

```ts
inputSchema: z.object({
  mode: z.enum(['text_to_video', 'animate_frame', 'composite_references']),
  prompt: z.string(),
  startImageFileId: z.string().optional(),   // required when mode === 'animate_frame'
  referenceFileIds: z.array(z.string()).min(1).max(3).optional(), // required when mode === 'composite_references'
}).refine(
  (v) => (v.mode === 'animate_frame') === (v.startImageFileId !== undefined),
  { message: 'startImageFileId is required for animate_frame and only for animate_frame' },
).refine(
  (v) => (v.mode === 'composite_references') === (v.referenceFileIds !== undefined),
  { message: 'referenceFileIds is required for composite_references and only for composite_references' },
)
```

**Relationship to the gateway's existing `task` field.** `task` on
`VideoGenerationRequest` (`video.ts`) is `'text_to_video' | 'edit' |
'extend'` today. The tool derives the gateway request's `task` from
`mode`: `text_to_video` → `task: 'text_to_video'`; `animate_frame` and
`composite_references` both → a new task value this spec adds. **[review-2]
Folded into the same spike as the URI question below** — whether Gemini's
Interactions API accepts a value like `image_to_video` for `task` is
asserted by Google's own Scene Machine reference code
(`actions_lib/omni.py`) but has the same unverified-against-our-actual-
integration status as the image-reference question; verify both in one
spike before implementation, not as two separate unknowns. `task: 'edit'`
stays unused by this skill (a different capability — video-to-video
restyling — out of scope here).

`animate_frame` = the referenced image is the literal first frame.
`composite_references` = the model builds a new scene incorporating the
referenced image(s) as identity anchors, not as the opening frame. Mutually
exclusive by the `.refine()` checks above, matching the
`start_image_url`/`reference_image_urls` XOR pattern found independently in
both Advibly's and Novoads' production skills.

**Namespaced model ids**, `vendor/model` form —
`google/gemini-omni-1.1-flash` — per `docs/media-generation/README.md`'s
convention. **[review-2] Migration site list corrected — five sites, not
three.** The bare id `gemini-omni-1.1-flash` appears in:
`generateVideo.ts`'s `VIDEO_MODEL` constant, `generationApproval.ts`'s call
site, `credit-rates.ts`'s seed, **and two sites the first revision
missed:** `video.ts`'s `VIDEO_MODEL_ALLOWLIST` (a mismatch here throws
`UnsupportedVideoModelError` → a 400 the tool surfaces as
`GENERATION_FAILED`, not an obviously-related error) and the `model:`
field actually sent in the gateway request body. All five must move
together in one change. **Also: `credit-rates.ts`'s seed only inserts a
row if one doesn't already exist for that subject** — a deployed
environment needs a real migration inserting the new namespaced row, not
a reseed, since the seed script won't touch an environment that's already
seeded once. Add a new namespaced row alongside the old one; remove the
old row only after confirming nothing else references it.

**A durable job id, minted before the vendor call.** **[review-2]
Derivation corrected — the prior draft cited the wrong object and had a
real double-refund/charge-suppression bug.** `toolCallId` lives directly
on the tool's `execContext` (`AgentToolExecutionContext.toolCallId`), not
on `execContext.requestContext` — read it from there. Derive the charge
key as `video:${conversationId}:${toolCallId}:${attempt}`, where
`attempt` starts at 0 and increments **only** after an actual refund has
completed — appending a static key with no attempt counter means
`refundVideoCharge`'s `${chargeKey}:refund` scheme leaves the original
debit key "spent," so any re-execution under the same `toolCallId` (an
approval-resume retry, or `StreamErrorRetryProcessor` retrying after a
transient error) would silently skip charging on the retried attempt —
free generation. A genuine user-initiated regenerate-with-different-
parameters gets a new `toolCallId` from Mastra and is unaffected by this
scheme.

**Charge before the vendor call, not after.** `generateVideo.ts` today
calls the gateway first and only calls `spendCredits` afterward — contradicts
`docs/media-generation/README.md`'s settled rule ("spend is charged before
the vendor call... closes the concurrency race"). Phase 0 reorders this:
resolve the rate and charge credits before calling the gateway, refunding
via `refundVideoCharge` on any post-charge failure.

**Product/reference images persisted to a URI before the generation
call, not passed inline — status: spike required, not confirmed.**
Scene Machine's working code proves this for Vertex's `gs://` URIs
specifically; it does not prove Gemini's Interactions API will accept a
presigned S3 URL the way our storage produces them. The current Omni call
body sends `input: req.prompt` as a bare string with no multimodal content
array at all, so this is new wire-format work regardless. **Spike required
before implementation**, combined with the `task` value question above:
confirm the Interactions API's actual accepted image-reference format; if
S3 URLs aren't fetchable, stage the image to a short-lived GCS object
first (mirroring Vertex's own requirement) as the fallback, not a design
blocker.

**`selectBackend(mode, constraints) → vendor/model`**, a pure resolver
inside the gateway's video handler, mirroring Scene Machine's
`generate_video.py` dispatching to `actions_lib/omni.py`/`actions_lib/veo.py`.
At Phase 0 it has exactly one real branch (`google/gemini-omni-1.1-flash`)
plus explicit `UNSUPPORTED_MODE` handling. This function is also where the
cross-vendor-substitution bug is fixed: a Gemini Omni failure surfaces as
an error, never silently retries against Vertex Veo.

**Per-backend limits become real wire parameters, not just validated
input.** Today's Omni call sends no aspect-ratio or duration field at all;
today's Veo call hardcodes `aspectRatio: '16:9'` unconditionally. Phase 0
adds aspect ratio and duration as real request parameters on both paths,
hard-validated (never silently clamped): Gemini Omni duration 3–10s (whole
seconds), aspect ratio 16:9 or 9:16 only, one clip per call, audio always
on (cannot be disabled via API).

### Open questions (Phase 0)

- **Reference image count cap** — set at 3 as a placeholder; confirm
  Gemini Omni's actual documented limit before implementation (a
  documentation lookup, not a design decision).
- **The combined image-format + task-value spike** described above — must
  resolve before implementation starts, not during it.

## Phase 0.5: resolve `project_delegate_network_migration`

No alternate path exists inside this spec's scope (see Problem, gap 3).
This phase is a pointer to that other body of work, tracked in its own
project memory, with one addition specific to this spec: **before Phase 1
implementation starts, add a test asserting that a `directorAgentDelegate`
tool call with `requireApproval` returning `true` actually pauses and
resumes correctly** — i.e. verify the fix against the exact call shape
this skill uses, not just against whatever call shape
`project_delegate_network_migration`'s own scope happened to test.

## Phase 1: the `template-video-generation` skill

### Architecture

**[review-2] Corrected — the prior "everything in Director" choice cannot
carry this workflow.** Director (`directorAgent`/`directorAgentDelegate`)
is a one-shot delegate: no `memory:` of its own (borrows the supervisor's,
per the existing code comment on `directorAgentDelegate`), and its tool
map has no dialogue/gate primitives (`ask_clarifying_questions`,
`request_upload`, `render_canvas` — none of these are registered on
Director). A workflow with multiple back-and-forth turns (intake
questions, brief confirmation, aspect-ratio confirmation, content-gate
confirmation) cannot live entirely inside one delegate call.

**Chosen split:**
- **Olmo carries the conversation**: intake, template/product resolution
  (calling `retrieve_template` — note this is currently registered only
  on Director; add it to Olmo's `SERVER_TOOLS` too, or have Olmo delegate
  a narrow "fetch this template" sub-call), brief presentation, aspect-
  ratio confirmation, the content/dialogue gate's user-facing confirmation
  step, and final delivery. This is prose added to Olmo's own
  instructions (`platformAgent.ts`), scoped so it only activates when the
  conversation is clearly about template-based ad generation — not a
  Mastra skill file (no filesystem skills capability exists on any agent
  in this codebase for a fixed built-in capability; see the rejected
  alternative below).
- **Director executes generation only**: Olmo delegates to
  `directorAgentDelegate` for the actual `analyze_video`/`analyze_audio`/
  `generate_video` calls once the brief is confirmed and gates have
  passed at the Olmo level. **[review-2] Consequence unchanged from the
  prior draft and still required**: `analyze_video`/`analyze_audio` must
  be added to `directorAgent`'s and `directorAgentDelegate`'s `tools:`
  maps — they exist only on `platformAgent` today.
- **[review-2] New, from `directorInstructions`'s actual structure**: any
  skill-specific instructions added to Director must be appended *after*
  the resolved `base` value in `directorInstructions`
  (`const base = override || defaultInstructions`), not merged into
  `defaultInstructions` itself — `defaultInstructions` is dropped
  entirely and silently for any tenant with a custom `agentSystemPrompt`
  set. Follow the same pattern `platformAgent.ts` already uses for its own
  layered instruction blocks, not a plain string concatenation into the
  default branch.

**Rejected: a filesystem or DB-backed Mastra skill.** No agent in this
codebase has a filesystem `skills:` capability; the only skills resolver
(`platformAgent.ts:370`) is a DB-backed, per-tenant, user-installable
system built for user-authored skills, not fixed built-in product
capabilities — using it here would mean seeding fake install rows for
something that isn't actually a user-installable skill. Prose additions
to Olmo's and Director's own instructions, as above, is the smaller,
correctly-scoped change.

### Conversational flow

1. **Intake** (Olmo). Template (via `retrieve_template` if the brief names
   one; otherwise a raw reference video handed to Director's
   `analyze_video` via delegation) + product photo. Product photo
   strongly recommended, three-tier fallback in order: (a) real product
   photo, (b) generate a still first via `generate_image` (delegated to
   Director) if none exists, (c) text-only with an explicit caveat that
   product identity will not be preserved. Never silently pick (c) when a
   photo could be provided.
2. **Analysis** (Director, delegated). Classify template profile —
   `visual_product_texture` / `human_demo` / `human_voiceover` /
   `platform_cta` / `mixed`. Extract beat structure via `analyze_video`/
   `analyze_audio`. Budget beats against Gemini Omni's actual 3–10s
   ceiling — do not sum shot durations and clamp after the fact.

   | Template profile | Generation mode |
   |---|---|
   | `visual_product_texture` | `animate_frame` if a product still exists; else `composite_references` |
   | `human_demo` | `composite_references` |
   | `human_voiceover` | `composite_references` — flag unproven voice/lip-sync fidelity to the user |
   | `platform_cta` | `animate_frame` on a generated product-visible ending still |
   | `mixed` | resolve to the dominant sub-profile; expose the choice in the brief rather than picking silently |

3. **Compact brief** (Olmo), 8–10 lines: template structure, product
   anchors, forbidden carryover (backed by `creative_templates.excludeInClone`),
   output defaults, one-line prompt preview.
4. **Aspect ratio lock** (Olmo). Confirm 16:9 or 9:16 before generation —
   passed through as a real wire parameter per Phase 0.
5. **Content/dialogue gate** (Olmo-level confirmation, enforced in Director's
   tool code before the actual `generate_video` call fires) — mandatory
   whenever the clone speaks. The user approves the literal spoken
   line(s) before any render. Any later edit voids the approval.
6. **Cost gate.** `generationApproval.ts`'s existing mechanism, now
   actually functional per Phase 0.5.
7. **Generate** (Director). Prompt in Subject + Action + Camera + Style +
   Constraints prose order (bulleted/`Label: value` prompts render as
   literal on-screen text). One primary action per shot. Label-hold
   instruction for visible printed text. Deliberate imperfection modifiers
   for UGC-style profiles.
8. **Post-generation QA** (Director, delegated). Transcribe the output via
   `analyze_audio` and diff against the approved script. Verify burned-in
   captions separately if present.
9. **Deliver** (Olmo). Show the result plainly with known limits stated,
   not overclaimed.

### Known limits, stated plainly rather than engineered around in v1

- Product identity is "recognizably similar," not pixel-exact.
- No true video-to-video structural cloning for generating new content
  from a reference video exists on Gemini Omni or Vertex Veo (a separate,
  narrower video-to-video *edit* capability does exist via `task: 'edit'`,
  out of scope for this skill).
- `human_voiceover`-profile templates are the least proven case for v1 —
  no lip-sync or voice-language locking mechanism is built in this phase.
- Multi-shot templates are handled as a single-clip compression within
  Omni's 3–10s ceiling for v1; a genuine multi-clip series is deferred to
  `short-drama-stitch`.

## Open questions (Phase 1)

- Exact wording/placement of the three-tier no-photo fallback message.
- Whether `retrieve_template` should be duplicated onto Olmo's tool set or
  called via a narrow Director delegation for the intake step — an
  implementation-level choice, resolve during planning.

## Next step

Per the brainstorming skill's architectural path: commit this spec, get
user review, then hand to the writing-plans skill — Phase 0, then Phase
0.5 (pointer to `project_delegate_network_migration`, plus the
call-shape-specific test it must include), then Phase 1. Phase 0.5 is an
unconditional blocker with no workaround: Phase 1 does not start without
it, full stop.
