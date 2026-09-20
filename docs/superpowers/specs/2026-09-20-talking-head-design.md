# talking-head skill — design

Date: 2026-09-20
Status: draft, pending user review

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
   text.** Cartesia is already integrated (`CARTESIA_API_KEY` wired,
   proven in production), but only for `apps/web/app/api/creative/voices`
   and `.../voices/preview` — a browser-facing voice-picker UI that
   plays fixed canned sample sentences. No code path calls Cartesia
   with our own script text. Confirmed in
   `docs/media-generation/README.md`'s "Confirmed still missing" list:
   "Full narration generation — Cartesia is wired only for voice
   preview, confirmed no full-narration call path."
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
  spec's first draft — see "Revision note" below.

## Revision note

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
- `generate_narration` tool — new.
- `lipsync` tool — new, vendor-swappable.
- `assemble_clips` tool — new, ffmpeg-based, self-hosted.

**Phase 1 (this spec, ships after Phase 0):** the `talking-head` skill.

**Explicitly out of scope for this spec:**
- Product/brand visibility is optional, not required — presenter-only
  talking-head ads (no product shown) are a valid output. If a product
  photo is supplied, skill 2's existing wordmark-verification machinery
  (`analyze_image` check) is reused unchanged, not rebuilt.
- Total ad length is capped at 30 seconds for v1 (no ad on Instagram/
  Shorts observed above ~45s; 30s leaves headroom). This caps clip
  count at 3 (`ceil(30 / 10)`).
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

### `generate_narration` — new tool

Mirrors `generateSong.ts`'s shape (existing music-generation tool):
takes a script string and a chosen Cartesia voice id, calls Cartesia's
real narration endpoint, uploads the result as a file, credit-gated
like every other generation tool.

```ts
inputSchema: z.object({
  script: z.string().max(1000).describe(
    'The full narration script — one continuous read, not pre-split into clip-sized segments.'
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

Calls `POST https://api.cartesia.ai/tts/bytes` with `model_id:
"sonic-3.5"`, `voice: { mode: "id", id: voiceId }`,
`output_format: { container: "wav", encoding: "pcm_s16le",
sample_rate: 44100 }` — matches the format the assembly step's ffmpeg
pipeline expects, avoiding a resampling step. The 1000-character cap
is a hard ceiling on script length (a 30s ad script is realistically
40-75 words / 250-500 characters, well under Cartesia's own ~900-1000
character single-call threshold where cross-segment prosody continuity
would otherwise require the websocket `continue`-chunk protocol — not
needed here and not built).

Duration is read from the returned WAV's header (`ffprobe` or an
equivalent lightweight parse) — this value drives Phase 1 step 4's
clip-count calculation, so it must be accurate, not estimated from
character count.

### `lipsync` — new tool, vendor-swappable

```ts
inputSchema: z.object({
  videoFileId: z.string(),
  audioFileId: z.string(),
  provider: z.enum(['fal_latentsync', 'sync_labs']).default('fal_latentsync'),
})
outputSchema: z.object({
  fileId: z.string().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
})
```

Default provider is `fal_latentsync` (fal.ai's hosted LatentSync,
`fal-ai/latentsync` — flat $0.20 for outputs ≤40s, fully managed
serverless, no GPU infrastructure to run ourselves). `sync_labs` (Sync
Labs' `sync-2.0`, $0.08/output-second) is available as a pricier,
higher-fidelity alternate — same provider-swap pattern already used by
`generate_video`'s multi-vendor planner (see
[[project_generation_planner_architecture]]), not a new architectural
idea for this codebase. Both providers take a `{video_url, audio_url}`
shape and return an async job to poll — matches the shape already used
by `generate_video`'s job/poll pattern, no new async-handling code
needed, same `check_media_job`-equivalent pattern.

### `assemble_clips` — new tool, self-hosted ffmpeg

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

Self-hosted ffmpeg (not a hosted editing API like Shotstack/Creatomate
— Gemini's research found self-hosted ffmpeg has lower latency, near-
zero per-render cost, and full filtergraph control, at the cost of
bundling a static ffmpeg binary; a hosted API adds 15-45s of network
round-trip and $0.03-0.08/render for a task this codebase can already
run itself in 2-5 seconds). Runs a filtergraph that normalizes every
input clip to constant frame rate (`fps=30`), a fixed aspect ratio
(`scale`+`pad`+`setsar=1` — Gemini Omni Flash's outputs are not
guaranteed to share identical dimensions/frame-rate across separate
renders), then `concat`s them. When `targetDurationSeconds` is set and
the concatenated video is longer, trims to that length; when shorter,
holds the final frame (`tpad`) rather than leaving trailing silent
dead air. Shared verbatim with skill 7's assembly needs — this tool is
not talking-head-specific.

Runtime: Node's `child_process.spawn('ffmpeg', args)`, matching the
existing tool-execution shape (no new async job/queue infra — clips
are short, ffmpeg concat of ≤3 ten-second clips completes in low
single-digit seconds per Gemini's research).

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
   with the full script and chosen voice — not split. Read the
   returned `durationSeconds`.
4. **Clip count** (Director). `clipCount = Math.ceil(durationSeconds / 10)`,
   capped at 3 (30s ceiling). If the script's resulting narration
   exceeds 30 seconds, tell the user plainly and ask them to shorten
   it rather than silently truncating.
5. **Per-clip stills** (Director, delegated). `generate_image` per
   clip, `referenceFileIds: [castSheet]`, `identityAnchor` set — one
   natural mid-speech pose per clip, following skill 3's motion-craft
   framing for what the still should freeze on. If a product photo was
   supplied, apply skill 2's existing wordmark-handling pattern
   unchanged on any clip where the product is visible.
6. **Board gate** (Olmo). All `clipCount` stills shown together,
   approved as one set, before any further paid spend — same rationale
   as skill 2's board-level approval (judging continuity beat-to-beat,
   not one still at a time).
7. **Per-clip silent video** (Director, delegated). `generate_video`,
   mode `animate_frame`, off each board-approved still — **no**
   `approvedDialogue`, no quoted speech in the prompt; these are
   silent renders. Skill 3's motion-craft rules apply (explicit hold,
   named easing, absence-at-0.0s) since the mouth's actual movement
   will be discarded/overwritten by the lip-sync step — what matters
   here is body/hand/product motion and a clean final hold.
8. **Assembly** (Director, delegated). One `assemble_clips` call, the
   `clipCount` silent clips in order, `targetDurationSeconds` set to
   the narration's duration from step 3.
9. **Lip-sync** (Director, delegated). One `lipsync` call: the
   assembled silent video + the narration file from step 3. Default
   provider (`fal_latentsync`) unless the user has asked for higher
   fidelity, in which case `sync_labs`.
10. **QA** (Director instruction, prose-level — same shipped pattern as
    skill 1/2, not code-enforced). Call `analyze_audio` (mode "deep")
    on the final lip-synced clip and compare its transcript to the
    original script, flagging any meaningful mismatch rather than
    presenting it as matching.
11. **Deliver** (Olmo). Present the one final assembled, lip-synced
    video. State plainly that this is one continuous ad, not multiple
    clips (contrast with skill 2's per-beat delivery).

### Cost/approval shape

Each paid step is its own cost-gated call, same "N cards is expected,
not an error" pattern as skill 2: cast sheet (1) + narration (1) +
stills (up to 3) + silent videos (up to 3) + assembly (1, likely free/
low-cost as pure local compute — verify against actual credit-rate
seeding before launch) + lip-sync (1). Worst case (3-clip ad): up to
10 approval cards, less than skill 2's per-beat-times-two shape for an
equivalent-length ad, since lip-sync collapses to one call regardless
of clip count.

### Known limits, stated plainly

- **30-second ceiling for v1.** A script producing more than 30s of
  narration is rejected with a clear message, not silently truncated.
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
  honestly, not implied to be stronger.
- **No batched/board-scoped cost approval** — same shared, deferred
  infra gap already named in skill 2's spec (`chatStream.ts`'s turn
  loop drops additional pending approvals rather than queuing them).
  Not re-solved here.

## Open questions

- **Single long-shot render feasibility** — worth a real, isolated
  test (one Seedance or equivalent 20-30s render, evaluated for
  identity/motion drift against the multi-clip-plus-assembly approach)
  before the next skill that could benefit from it (skill 7). Not
  blocking this spec.
- **`assemble_clips`' actual credit cost** — Phase 0 needs a real
  credit-rate seed decision (local ffmpeg compute vs a flat low
  per-call charge) before Phase 1 ships; not yet decided.
- **Lip-sync provider evaluation in practice** — `fal_latentsync` is
  the recommended default from Gemini's research, not yet tested
  against our own generated footage; worth a real test render before
  committing to it as the hard default rather than just the schema
  default.

## Next step

Hand to the writing-plans skill for an implementation plan, Phase 0
first (`generate_narration`, `lipsync`, `assemble_clips`) before Phase 1.
