# talking-head skill — design

Date: 2026-09-20
Status: revised after Opus review — pending user review

## Revision note (round 2)

An architectural review, before implementation planning, found the
first draft's Phase 0 diverged from a settled decision: every existing
generation tool (`generateVideo.ts`, `generateImage.ts`,
`generateSong.ts`) calls `apps/inference-gateway`, never a vendor
directly — the gateway is "the single point for all vendor calls...
vendor specifics live behind adapters; nothing above the gateway knows
which vendor served a request" (`docs/media-generation/README.md`).
The first draft had `generate_narration` and `lipsync` calling
Cartesia/fal.ai/Sync Labs directly from the orchestrator tool, which
would have added new vendor secrets straight to the orchestrator,
bypassing the gateway's cost/allowlist/adapter layer. **Confirmed with
the user: both new capabilities route through the gateway**, matching
every sibling tool. This round rewrites Phase 0 accordingly and fixes
several other review findings — see the list after the architecture
section for what changed and why.

## Problem

`apps/agent-orchestrator` can clone a template (skill 1) and build a
multi-beat UGC storyboard ad (skill 2, with skill 3's motion-craft
rules layered on top), but has no skill for a single continuous
presenter speaking to camera for 15-30 seconds — the "talking-head"
spokesperson format common in explainer/announcement/testimonial-style
ads. This is skill 4 of 7 in the planned sequence.

Unlike skills 1-3, this skill has real infrastructure gaps, none of
which exist anywhere in the codebase today:

1. **No tool generates a full narration clip from arbitrary script
   text.** Cartesia is already integrated (`CARTESIA_API_KEY` wired in
   `apps/web`, proven in production), but only for
   `apps/web/app/api/creative/voices` and `.../voices/preview` — a
   browser-facing voice-picker UI that plays fixed canned sample
   sentences. No code path calls Cartesia with our own script text,
   and the orchestrator/gateway have no Cartesia credential at all
   today. Confirmed in `docs/media-generation/README.md`'s "Confirmed
   still missing" list: "Full narration generation — Cartesia is wired
   only for voice preview, confirmed no full-narration call path" and
   "Presenter video (avatar + narration → talking video) — not found
   anywhere in the orchestrator."
2. **No lip-sync mechanism exists.** Needed because the voice-drift fix
   (render silent, add one continuous external voiceover — see
   [[project_advibly_skills_notes]]) leaves the presenter's mouth
   un-synced to the added narration unless something matches motion to
   audio afterward.
3. **No clip-assembly/concatenation capability exists anywhere.**
   Confirmed in the same "Confirmed still missing" list: "Script/shot-
   plan generation and final assembly (captions, music, product shots,
   transitions → MP4) — not found." A 15-30s ad needs multiple ~10s
   renders (the `generate_video` tool's `durationSeconds` cap) joined
   into one file. This is shared prerequisite infra also needed by
   skill 7 (`short-drama-stitch`).

**ffmpeg is not a new dependency.** `apps/agent-orchestrator/src/media.ts`
already shells out to `ffmpeg`/`ffprobe` via `execFile` for
`analyze_video`'s frame extraction (`FFMPEG_TIMEOUT_MS` guard already
exists there). Assembly needs a live `which ffmpeg` check on the VM as
a sanity step, not a new binary to install.

## Research basis

- Five production implementations already read for skills 1-3:
  Advibly's `ugc-ads`, novoads' `clone-image-ad`/`image-to-motion`/
  `pixar-ad`/`clone-video-ad`. See [[project_ugc_character_skill_notes]],
  [[project_ugc_first_frame_skill_notes]], [[project_advibly_skills_notes]].
  None of these sources shipped a talking-head-specific skill — Advibly
  mentions a tool called `advibly_generate_talking_video` only in
  passing, no actual skill file exists for it in the cloned repo.
- Cloned and researched `Anil-matcha/Open-Generative-AI` (open-source,
  27.7k-star AI generation studio) specifically for lip-sync and
  assembly patterns. Finding: it is a thin proxy over muapi.ai — every
  studio (including its `LipSyncStudio` and Workflow Studio's "Video
  Combiner" node) just builds a JSON payload, POSTs to muapi.ai, and
  polls for a result URL. No local media processing, no orchestration
  logic worth porting as code — but it surfaced a concrete, real vendor
  shortlist for lip-sync (Sync.so, VEED, Creatify, LTX, LatentSync) and
  confirmed the `{video_url, audio_url} → poll → result_url` request
  shape as a validated pattern. Its "Video Combiner" node also confirmed
  that even a dedicated combiner API has no audio-track input — it only
  concatenates ordered video URLs, matching our own finding that
  assembly and audio-muxing are separate concerns.
- A user-run Gemini deep-research pass (2026-09-20) answered three
  further questions and produced one material correction to this
  spec's first draft (narration/assembly ordering) — see "Revision note
  (round 1)" further below, preserved for history.
- An Opus architectural review (2026-09-20, before writing-plans) found
  the gateway-routing gap above plus the corrections folded into this
  round — see "Revision note (round 2)" at the top.

## Revision note (round 1)

The first draft of this spec (during brainstorming, before the Gemini
research came back) proposed splitting the script into per-clip
segments, generating narration per segment, and lip-syncing each
silent clip against its own segment before concatenating the
already-synced clips. The Gemini research corrected this:

**Splitting narration across clip boundaries truncates words and
introduces audible seams** — independent TTS calls have no shared
phonetic/prosodic context, so pitch and cadence reset at each seam.
The corrected order is **narration-first, concat-before-sync**:
generate one continuous narration for the whole script, use its
duration to compute how many silent clips are needed, concatenate
those silent clips into one video, then run lip-sync **once** on the
whole assembled video against the one narration track. This also cuts
the lip-sync call count from up to 3 (one per segment) to exactly 1
per ad, regardless of clip count — cheaper and structurally simpler.
This spec reflects the corrected order throughout.

The same research also confirmed **no all-in-one hosted platform**
(HeyGen, Synthesia, D-ID, Hedra, Argil, Captions.ai) accepts our own
pre-rendered, custom-presenter silent video clips and an external
script to return one assembled, lip-synced ad — they are each built
around either static-portrait warping or platform-enrolled avatars,
incompatible with a presenter generated fresh per conversation via
Gemini image/video generation. This validates building the modular
pipeline below rather than adopting a single vendor.

## Scope

**Phase 0 (prerequisite, this spec, build first — shared with skill 7):**
- Two new gateway routes: `POST /v1/audio/speech` (Cartesia) and
  `POST /v1/video/lipsync` (fal.ai LatentSync default, Sync Labs
  alternate) in `apps/inference-gateway`.
- `generate_narration` tool — new, calls the gateway.
- `lipsync` tool — new, calls the gateway; vendor choice is gateway
  config, not a model-visible tool input.
- `assemble_clips` tool — new, ffmpeg-based, self-hosted, orchestrator-
  local (no gateway involvement — no vendor call).
- Credit-rate seed rows, `GENERATION_APPROVAL_METADATA` entries, and
  per-tool refund helpers for all three new tools.

**Phase 1 (this spec, ships after Phase 0):** the `talking-head` skill.

**Explicitly out of scope for this spec:**
- Product/brand visibility is optional, not required — presenter-only
  talking-head ads (no product shown) are a valid output. If a product
  photo is supplied, skill 2's existing wordmark-verification machinery
  (`analyze_image` check) is reused unchanged, not rebuilt.
- Total ad length is capped at 30 seconds for v1 (no ad on Instagram/
  Shorts observed above ~45s; 30s leaves headroom). This caps clip
  count at 3.
- A single long-duration (20-30s) one-shot video render, avoiding
  multi-clip assembly entirely, is **not** adopted in this version.
  Every research source that discusses beat/shot duration assumes
  short (3-10s) renders specifically because that is where identity
  and motion control is reliable — no source tested a single 20-30s
  render. A longer-duration model (e.g. BytePlus Seedance, already
  flagged as a deferred option — see
  [[project_seedance_video_provider_swap_option]]) might remove the
  need for assembly entirely, but per that memory's own standing rule,
  we do not swap providers or architectures speculatively, only after
  evidence the current approach underdelivers. Tracked as an open
  question below, not adopted.
- Multi-ad, multi-ad-variant batching — out of scope, matches skill 2's
  existing single-ad-per-conversation scope.

## Phase 0: prerequisite tool work

### Gateway routes — new

`apps/inference-gateway/src/index.ts`'s dispatch block gains two
routes, following the same shape as the existing
`/v1/images/generations`, `/v1/music/generations`,
`/v1/video/generations` routes (internal-service-key auth, model
allowlist, vendor call, normalized response):

- **`POST /v1/audio/speech`** — body `{ model: 'sonic-3.5', transcript,
  voiceId, outputFormat }`. Calls Cartesia's `POST /tts/bytes`
  server-side (Cartesia credential lives in the gateway's secrets,
  never the orchestrator). A single `Cartesia-Version` header value is
  picked and used consistently (the two existing `apps/web` call sites
  currently disagree — `2026-03-01` vs `2026-08-14` — this is a known
  small inconsistency to resolve when the gateway route is built, not
  part of this spec's scope to fix in `apps/web`). Returns the audio
  bytes plus a duration read server-side (via `ffprobe` on the
  gateway, or Cartesia's own response metadata if it exposes duration
  directly — confirm at implementation time) so the orchestrator tool
  never has to parse a WAV header itself.
- **`POST /v1/video/lipsync`** — body `{ model, videoUri, audioUri }`.
  `model` is one of the gateway's own allowlisted lip-sync model ids
  (e.g. `fal-ai/latentsync`, `sync-2.0`) — the orchestrator tool passes
  a `model` string the same way `generateVideo.ts` does today, not a
  bare `provider` enum the LLM picks arbitrarily. Calls the chosen
  vendor, polls until the job resolves, returns the result.

### `generate_narration` — new tool

Calls the gateway's new `/v1/audio/speech` route — mirrors
`generateVideo.ts`'s shape (fetch-the-gateway, charge-before-call,
`toolCallId`-derived chargeKey), **not** `generateSong.ts`'s (which
charges after the vendor call and derives its chargeKey from a fresh
`randomUUID()` each execution, making `spendCredits`' idempotency a
no-op — both are known, already-flagged divergences in `generateSong.ts`,
not a pattern to copy).

```ts
inputSchema: z.object({
  script: z.string().max(500).describe(
    'The full narration script — one continuous read, not pre-split into clip-sized segments. ~500 characters is roughly 30-35 seconds of speech at typical ad pacing, matching this skill's 30s ceiling.'
  ),
  voiceId: z.string().describe('A Cartesia voice id, from the existing curated voice list.'),
})
outputSchema: z.object({
  fileId: z.string().optional(),
  durationSeconds: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
})
```

The 500-character cap (tightened from an earlier 1000-character draft)
refuses an overlong script **before** any charge — 1000 characters is
roughly 60-70s of speech, nearly double the 30s ceiling, which would
otherwise let a script pass the schema, get charged, and only fail the
duration check in Phase 1 step 4 after the spend already happened.

Charge-before-call, `agentId` left `undefined` (never `?? ''`),
chargeKey derived from `execContext.agent.toolCallId` — all three
exactly as `generateVideo.ts` does it and its inline comments explain
why (the `''::uuid` Postgres cast failure and the chargeKey-must-be-
per-call reasoning both apply identically here).

### `lipsync` — new tool

Calls the gateway's new `/v1/video/lipsync` route.

```ts
inputSchema: z.object({
  videoFileId: z.string(),
  audioFileId: z.string(),
  model: z.string().default('fal-ai/latentsync').describe(
    'A gateway-allowlisted lip-sync model id. Default is cheaper and fully managed; relative output quality against the alternate (sync-2.0) is untested — see Open Questions.'
  ),
})
outputSchema: z.object({
  fileId: z.string().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
})
```

**This is new async-handling code, not a reuse of an existing
pattern.** `generate_video` is synchronous today (a single fetch with
a 270-second timeout, no job id, no polling — confirmed in
`generateVideo.ts` and `docs/media-generation/README.md`'s "Video
generation has no async job layer" item) and no `check_media_job`-
style tool exists anywhere in this codebase. `lipsync` needs its own
poll loop against the gateway, with an explicit timeout budget (a
LatentSync render of a ~30s clip is plausibly 1-3 minutes) and a
decision on behavior past that budget — this has to run inside a live
SSE chat turn, since no SQS/watchdog async bridge exists yet (same
gap the README names for video generation generally). Recommend
matching `generate_video`'s existing in-turn blocking-timeout shape
(e.g. a 270s cap, refuse with a clear timeout reason past it) rather
than inventing a new pattern, until the async job-layer gap is solved
platform-wide.

### `assemble_clips` — new tool, self-hosted ffmpeg, orchestrator-local

No gateway involvement — this is local compute, not a vendor call.

```ts
inputSchema: z.object({
  clipFileIds: z.array(z.string()).min(1).max(3),
  targetDurationSeconds: z.number().optional().describe(
    'When set, the assembled video is trimmed (extra tail dropped) or the final frame held (tpad) to match this length — used to align the silent clip total to the narration track length.'
  ),
  aspectRatio: z.enum(['16:9', '9:16']),
})
outputSchema: z.object({
  fileId: z.string().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
})
```

Mechanics, matching `media.ts`'s existing ffmpeg-invocation pattern
rather than inventing a new one:
- **Download inputs first.** `clipFileIds` need local paths before
  ffmpeg can touch them — use the existing
  `fetchPresignedUrl`/`downloadToSessionCache` path (`mediaCache.ts`),
  which already handles the `idToken`/tenant-scoped cache directory.
  Add a `MAX_CLIP_BYTES` cap, matching `analyzeVideo.ts`'s
  `MAX_VIDEO_BYTES` pattern.
- **Use `execFile`, not `spawn`.** `media.ts` already uses
  `promisify(execFile)` with a timeout/signal — match that instead of
  hand-rolling a new process-timeout pattern with `spawn`.
- **Strip audio explicitly (`-an`)** on every input before concat.
  Gemini Omni Flash's silent-mode output is not guaranteed to have no
  audio stream at all, and `concat` fails outright when inputs
  disagree on stream presence. The lip-sync step supplies the only
  audio that matters later.
- Normalize every input clip to constant frame rate (`fps=30`) and a
  fixed aspect ratio (`scale`+`pad`+`setsar=1` — Gemini Omni Flash's
  outputs are not guaranteed to share identical dimensions/frame-rate
  across separate renders), then `concat`.
- When `targetDurationSeconds` is set and the concatenated video is
  longer, trim to that length; when shorter, hold the final frame
  (`tpad`) rather than leaving trailing silent dead air.

Shared verbatim with skill 7's assembly needs — this tool is not
talking-head-specific.

**Clip-duration distribution (was undefined in round 1 — a real gap).**
`clipCount = Math.ceil(narrationDuration / 10)` alone doesn't say what
duration each individual clip renders at. Taken literally (all clips
at the full 10s cap), a 22-second narration would render 3×10s=30s of
paid video and then trim 8 seconds — most of a full paid render
thrown away, and the cut lands mid-clip rather than at a clip
boundary. Instead: **render `clipCount` clips whose integer durations
sum to `Math.ceil(narrationDuration)`, front-loaded toward 10s where
possible** (a 22s narration → 10+9+3 or similar, not 10+10+10). Two
edge cases: a narration under 3 seconds still renders one clip at
`generate_video`'s 3-second floor (`durationSeconds` cannot go below
3), with `tpad` absorbing the small excess; `targetDurationSeconds`
then only needs to absorb whatever sub-second remainder integer
durations can't hit exactly, not seconds of a wasted extra clip.

### Credit-rate seeding, approval-card metadata, refund helpers — required, not optional

Three registration points the round-1 draft omitted entirely, each a
silent-failure mode if skipped:

1. **Credit-rate seed rows** in
   `packages/foundation/database/seeds/credit-rates.ts` for all three
   new tools. Without a seeded rate, `shouldRequireApproval` finds no
   rate and returns `false` (`generationApproval.ts`), and the charge
   block is skipped with an `UNBILLED` console error — the tool runs
   free and unapproved, with no user-visible symptom.
2. **`GENERATION_APPROVAL_METADATA` entries** (`generationApproval.ts`)
   for all three tools, under **both** the hyphenated tool id and the
   underscored key the model calls it by — every one of these tools
   runs under Director-as-delegate, and a missing metadata entry there
   causes the approval card from a delegate call to fall through to
   chatStream's unmapped-tool fallback, which crashes resuming the
   stream (`resumeStream() cannot resume tool call ... because it is
   not suspended`).
3. **Per-tool refund helpers**, matching the existing
   `refundVideoCharge`/`refundImageCharge`/`refundSongCharge` pattern
   (one per new tool, each with its own `jobType`) — without one, a
   charge that succeeds but is followed by a failed upload/gateway
   response leaves the tenant charged with nothing to show for it.

## Phase 1: the `talking-head` skill

### Conversational flow

1. **Intake** (Olmo). Full script text, a Cartesia voice pick (reusing
   the existing curated voice-list/preview UI — no new voice-browsing
   work needed), optional product photo, presenter look brief.
2. **Cast sheet** (Director, delegated). Same mechanism as skill 2 —
   one `generate_image` call producing the presenter reference, Olmo
   derives and stores a terse tag + style-lock paragraph in working
   memory, enforced verbatim via the existing `identityAnchor` gate.
3. **Narration** (Director, delegated). One `generate_narration` call
   with the full script and chosen voice — not split. **Olmo writes
   both the returned `fileId` and `durationSeconds` into working
   memory's `Locked Reference Artifact IDs`, alongside the cast
   sheet.** This is not optional bookkeeping: `directorAgentDelegate`
   has no memory of its own (same structural finding as skill 2's
   spec), so without this, any retry from step 5 onward silently
   re-calls `generate_narration` — a fresh charge, a fresh approval
   card, and potentially a different `durationSeconds` that no longer
   matches the already-approved stills' implied clip count.
4. **Clip count and per-clip durations** (Director). Compute
   `clipCount = Math.ceil(durationSeconds / 10)`, capped at 3 (30s
   ceiling — if exceeded, tell the user plainly and ask them to
   shorten the script; this should be rare given the 500-character
   schema cap already refusing most overlong scripts before this
   point). Compute each clip's target render duration per the
   front-loaded distribution described in Phase 0's `assemble_clips`
   section, not a flat `durationSeconds / clipCount` split.
5. **Per-clip stills** (Director, delegated). `generate_image` per
   clip, `referenceFileIds: [castSheet]`, `identityAnchor` set — one
   natural mid-speech pose per clip. **Every clip's still must keep the
   presenter's face visible, front-facing (or near-front-facing), and
   singular** — the lip-sync model tracks and rewrites one face, and a
   clip where the presenter turns away, leaves frame, or is replaced by
   a product-only insert will garble or fail lip-sync later. If a
   product photo was supplied, apply skill 2's existing wordmark-
   handling pattern unchanged on any clip where the product is also
   visible alongside the presenter, not in place of them.
6. **Board gate** (Olmo). All `clipCount` stills shown together,
   approved as one set, before any further paid spend — same rationale
   as skill 2's board-level approval (judging continuity beat-to-beat),
   with the added talking-head-specific check named in step 5: does
   the presenter's face stay visible and consistent across every
   still.
7. **Per-clip silent video** (Director, delegated). `generate_video`,
   mode `animate_frame`, off each board-approved still, at that clip's
   computed duration from step 4 — **no** `approvedDialogue`, no
   quoted speech in the prompt; these are silent renders. Skill 3's
   motion-craft rules mostly apply unchanged (absence-at-0.0s, named
   easing, staggered elements), **with one talking-head-specific
   override**: skill 3's "pin the final state" rule is written for a
   standalone beat and, applied to every clip here, produces a
   decelerate-and-hold rhythm on each of up to 3 clips concatenated
   under one continuous voice track — the opposite of the "one
   continuous ad" this skill delivers (step 11). Only the **last**
   clip should pin to a final held state; non-final clips should hand
   off on sustained motion, so the cut between them reads as a
   continuation rather than a series of separate held shots. The
   narration itself will still read continuously across the cut (it's
   one unbroken track), so a visible jump-cut at the clip boundary is
   an accepted, deliberate trade-off here, not a defect to hide —
   name it to the user as a known limit (see below) rather than
   pretending the cut is invisible.
8. **Assembly** (Director, delegated). One `assemble_clips` call, the
   `clipCount` silent clips in order, `targetDurationSeconds` set to
   the locked narration duration from working memory (step 3) — never
   a freshly re-read value.
9. **Lip-sync** (Director, delegated). One `lipsync` call: the
   assembled silent video + the locked narration file from working
   memory. Default `model` (`fal-ai/latentsync`) unless the user has
   asked for higher fidelity, in which case `sync-2.0`.
10. **QA** (Director instruction, prose-level — same shipped pattern as
    skill 1/2, not code-enforced). Call `analyze_audio` (mode "deep")
    on the final lip-synced clip and compare its transcript to the
    original script, flagging any meaningful mismatch rather than
    presenting it as matching. **Known gap:** `analyzeAudio.ts`'s
    `MAX_AUDIO_BYTES` (15MB) may reject a 30-second assembled 1080p
    lip-synced file before a transcript is even attempted — this QA
    step can fail with a size error rather than a real QA result; not
    solved in this spec, named as a known limit below.
11. **Deliver** (Olmo). Present the one final assembled, lip-synced
    video. State plainly that this is one continuous ad with a
    deliberate cut between clips (per step 7), not multiple separate
    clips (contrast with skill 2's per-beat delivery).

**Script edits invalidate downstream work.** The script locks at step
3 (narration generation). If the user wants to change the wording
after seeing the board (step 6) or later, narration must be
regenerated from step 3 — the stills generated so far are sunk cost,
and this should be stated to the user plainly when it happens, not
silently absorbed.

### Cost/approval shape

Each paid step is its own cost-gated call, same "N cards is expected,
not an error" pattern as skill 2. Skill 2's real structure is
`1 cast sheet + N stills + N videos = 2N+1` cards (an equivalent 3-beat/
30s ad: 7 cards). Talking-head's structure is `1 cast sheet + 1
narration + clipCount stills + clipCount videos + 1 assembly + 1
lip-sync`. Worst case (3 clips): up to **10** cards — three more than
skill 2's equivalent, not fewer. The extra three are narration,
assembly, and lip-sync — capabilities skill 2 simply doesn't have —
and lip-sync stays at exactly one card regardless of clip count. The
real range is 8-10 depending on whether assembly ends up seeded as a
free/near-zero local-compute rate or a small flat charge (see Open
Questions).

### Known limits, stated plainly

- **30-second ceiling for v1.** A script producing more than 30s of
  narration is rejected with a clear message, not silently truncated;
  the 500-character schema cap on `generate_narration` refuses most
  overlong scripts before any charge, with the duration check in step
  4 as a backstop for scripts that are short in characters but slow in
  spoken pacing.
- **A visible cut exists between clips.** Per step 7, only the final
  clip holds a pinned end state — non-final clips hand off on motion,
  and the concatenation point is a deliberate, accepted jump-cut, not
  hidden. The narration audio itself remains continuous across it.
- **No single long-shot render tested or adopted.** See "Explicitly
  out of scope" above — a real, open question, not a decision.
- **Character/cast sheet persists only in this conversation's working
  memory**, same limit as skill 2.
- **`assemble_clips` and `lipsync` share infra with skill 7** — a bug
  or limitation found in either tool affects both skills; changes to
  these tools should be evaluated against both skills' needs, not just
  talking-head's.
- **Post-generation transcript QA is a Director instruction, not a
  code-enforced check** — matches skill 1/2's current shipped behavior
  honestly, not implied to be stronger. It may also fail outright on a
  file exceeding `analyzeAudio.ts`'s 15MB cap for a full assembled
  clip — not solved in this spec.
- **No batched/board-scoped cost approval** — same shared, deferred
  infra gap already named in skill 2's spec (`chatStream.ts`'s turn
  loop drops additional pending approvals rather than queuing them).
  Not re-solved here.
- **`lipsync`'s poll loop runs in-turn, blocking, with no async job
  layer** — same platform-wide gap `generate_video` already has;
  worth solving once, shared, rather than per-tool, but not solved in
  this spec.

## Open questions

- **Single long-shot render feasibility** — worth a real, isolated
  test (one Seedance or equivalent 20-30s render, evaluated for
  identity/motion drift against the multi-clip-plus-assembly approach)
  before the next skill that could benefit from it (skill 7). Not
  blocking this spec.
- **`assemble_clips`' actual credit cost** — Phase 0 needs a real
  credit-rate seed decision (near-zero local-compute rate vs a small
  flat per-call charge) before Phase 1 ships; not yet decided. Affects
  the approval-card count named above (8 vs 10 in the worst case).
  Also affects whether `assemble_clips` needs a `requireApproval` gate
  at all, versus running as an un-gated internal step like a normal
  tool call with no cost attached. Resolve before implementation: is a
  zero-cost internal tool even routed through the same
  `shouldRequireApproval` path, or does it need a distinct "no
  approval, no charge" shape? Not yet decided; flag to whoever writes
  the implementation plan.
- **Lip-sync provider evaluation in practice** — `fal-ai/latentsync` is
  the recommended default on cost and operational grounds (flat $0.20
  vs `sync-2.0`'s $0.08/output-second, a 12x spread for a 30s ad), not
  a demonstrated quality advantage — relative output quality against
  `sync-2.0` is untested against our own generated footage. Worth a
  real comparison render before treating the default as more than a
  starting point.
- **`Cartesia-Version` header inconsistency** — `apps/web`'s two
  existing Cartesia call sites use different header values
  (`2026-03-01` vs `2026-08-14`). The new gateway route should pick
  one value deliberately at implementation time; not a decision this
  spec makes, and not a reason to block Phase 0 on reconciling
  `apps/web`'s existing routes.

## Next step

Hand to the writing-plans skill for an implementation plan, Phase 0
first (gateway routes, then `generate_narration`, `lipsync`,
`assemble_clips`, then credit-rate/approval-metadata/refund-helper
registration) before Phase 1.
