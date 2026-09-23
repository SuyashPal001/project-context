# short-drama-stitch skill — design

Date: 2026-09-22
Status: revised after Opus architectural review round 1 — pending user review

## Revision note (round 1)

An architectural review checked every reuse/"already exists" claim
against the real shipped code (skill 5's own precedent, `assembleClips.ts`,
`analyzeVideo.ts`, `chatStream.ts`, `generationApproval.ts`,
`credits.ts`/`credit-rates.ts`) rather than taking the first draft's claims
on faith, including LIVE ffmpeg runs against the proposed xfade/acrossfade
graph. Three Critical, three Important, three Minor findings came back, all
folded in below:

1. **Critical.** `analyze_video` returns prose only (`analyzeVideo.ts:54-60`)
   — no timestamps, no duration, frames aren't time-labeled in the gateway
   prompt. Mode A ("AI proposes in/out timestamps from a summary") was not
   implementable against the shipped tool. Fixed by moving `analyze_video`
   from "reused untouched" to "extended" (see below) and giving the Director
   a real timestamp source.
2. **Critical.** `overlapSeconds: 0` does not behave as "a zero-length
   crossfade routed through xfade" in real ffmpeg: video `xfade duration=0`
   silently drops the second clip entirely (verified live, exit 0, no
   error); audio `acrossfade d=0` falls through to a ~0.92s default via
   `nb_samples`, the exact opposite of zero. Fixed by forbidding
   `overlapSeconds: 0`/omitted on `type: 'xfade'` at the schema level —
   a zero-length transition is expressed as `type: 'cut'`, never as an
   xfade with no width.
3. **Critical.** Grafting xfade onto the current single n-way `concat`
   graph is not "reuse the per-input chains, swap concat for xfade" — xfade
   is strictly pairwise with an absolute `offset`, requiring a new
   ffprobe-per-input pass, a running-offset accumulator, and a sequential
   pairwise/segmented graph builder (verified working live, see Data flow
   step 5 below for the confirmed-correct filter shape). This is real new
   filter-graph work, not a one-line swap.
4. **Important.** The caption/brand-name gate is prose-only in
   `directorAgent.ts` instructions today, not a code-level hard block, and
   skill 5's version compares against an approved narration script skill 7
   never has (skill 7 generates no speech). "Reused unchanged" was wrong on
   both the mechanism and the referent. Fixed with a skill-7-specific
   referent (see Hard Constraints).
5. **Important.** An unseeded `ffmpeg-trim-clip` rate row doesn't just
   leave the tool "unbilled" — `shouldRequireApproval` returns `false` with
   no rate row, so the tool runs free AND with no approval card at all,
   defeating gate 1. Added as an explicit deploy prerequisite.
6. **Important.** `FFMPEG_TIMEOUT_MS` (60s) and `MAX_CLIP_BYTES` (200MB)
   are sized for skill 4/5's short generated clips, not 8 real uploaded
   camera clips plus an xfade chain. Both need an explicit decision, not
   silent inheritance.
7. **Minor.** `chatStream.ts`'s three attachment lists normalize away
   underscores before lookup — only the hyphenated `'trim-clip'` is needed
   there (unlike `GENERATION_APPROVAL_METADATA`, which genuinely needs
   both forms). Corrected.
8. **Minor.** `transitions` passed with `preserveAudio` left at its
   `false` default silently no-ops instead of loudly rejecting, breaking
   this codebase's established convention (`.refine` rejects incompatible
   combinations, it doesn't ignore them). Added a second `.refine`.
9. **Minor.** The Credits section's "covers the transitions addition"
   language read as a cost-recovery claim when it's actually a gate-
   mechanics claim (the flat rate was never about compute cost). Reworded.

## Problem

`apps/agent-orchestrator` can clone a template (skill 1), build photoreal
UGC storyboards (skills 2/3), generate a single continuous photoreal
presenter (skill 4), and generate a stylized animated character-driven ad
from scratch (skill 5). This is skill 7 of 7: **short-drama-stitch**, the
only one of the seven skills that does not generate any video. The user
already has footage — real short-drama/episodic clips, multiple takes, raw
b-roll — and wants an ad-length cut assembled from it: pick the best
segments, order them, cross-fade between them, layer captions and a music
bed on top. It is an editing skill, not a generation skill.

## Research basis

Two prior-art sources, both read in full this session:

- **Google Scene Machine's `combine_video.py`** (`actions/combine_video.py`)
  — a real, shipped arrangement-JSON-driven ffmpeg concat engine. Takes a
  list of video/audio/image entries, each with `file_path`,
  `start_time`/`skip_time`/`duration`, and video entries carry an optional
  `transition` (an ffmpeg `xfade` name) plus `transition_overlap`. Builds
  one `FFMPEG` object incrementally (`add_video`/`add_audio`/`add_image`)
  and calls `combine()` once. This IS genuine prior art for a multi-clip
  stitch tool — the closest thing to what this skill needs.
  `edit_video.py`, read alongside it, turned out to be unrelated: a
  single-video, single-prompt Gemini Omni in-place video edit, not a
  concat/stitch operation. `generate_arrangement.py` is an admitted stub
  the real product never uses — real arrangements are hand-built (by a UI
  or, here, an agent).
- **Advibly's `explainer-videos` and `vox-explainer`** skills, read in full.
  Both are generation skills (styled keyframes → animated clips → stitched)
  and don't directly address "stitch existing footage," but their shared
  pipeline shape (mandatory approval gate before spend, one style/model
  locked per delivered ad, SFX-only clip audio with VO/music layered
  separately in a final compose step) confirms this project's own
  established pattern is the right one to keep following, not an outlier.

One concrete gotcha carried forward from `combine_video.py`: it explicitly
guards against a falsy-vs-absent bug on `transition_overlap` — an explicit
`0` must mean "hard cut," and must not silently fall back to a nonzero
default the way an unset value would. This skill's own transitions field
repeats that exact guard (see Hard Constraints).

## What we build vs. what we reuse

Skill 7 reuses more of the existing tool surface than any prior skill,
because it needs no new generation capability at all:

**Reused untouched:**
- `transcribe_audio`, `burn_captions`, `generate_song`, `mix_music_bed` —
  all shipped in skill 5, used here completely unchanged, same call
  shapes, same pipeline position (captions before music, music bed last).

**Extended:**
1. `analyze_video` — currently returns `{ success, summary: string,
   frameCount, partial, error }` only (`analyzeVideo.ts:54-60`); no
   timestamps, no duration reach the model or the caller. Extended to:
   (a) return `durationSeconds` in its output (the value is already
   computed internally by `extractVideoFrames` and simply discarded today
   — this is exposing an existing value, not new computation); (b) label
   each sampled frame with its real timestamp in the gateway prompt (frames
   are evenly spaced at `duration/maxFrames`, so each frame's timestamp is
   already known — `callGatewayForFrames` interleaves a `"Frame N at
   t=X.Xs"` text block before each image); (c) the "deep" mode prompt is
   reworded to ask for a rough timestamp range per notable beat/moment,
   not just a prose description. This gives the Director real (if
   approximate — the model still eyeballs where a "beat" starts/ends
   within the frame grid) timestamps to propose a cut list from, and gives
   it clip duration to size a proposal against the target length at all.
   `analyzeAudio.ts` and every ffprobe-internal tool (`compositeEndCard.ts`,
   `mixMusicBed.ts`, `muxBeatAudio.ts`) were checked — none of them expose
   duration to the model either, confirming this gap was real, not a
   one-off.
2. `assemble_clips` — `clipFileIds` cap raised `.max(4)` → `.max(8)`.
   New optional `transitions` parameter: an array of per-boundary
   `{ type: 'xfade', name: string, overlapSeconds: number }` (overlap
   required, `> 0` — a zero-width transition is expressed as `type:
   'cut'`, which carries no `overlapSeconds` field at all — never as an
   xfade with `overlapSeconds: 0`) `| { type: 'cut' }`, length =
   `clips.length - 1`, consumed only when `preserveAudio: true`.
   **This is a filter-graph rewrite, not an added flag.** The current
   code builds one n-way `concat` (`assembleClips.ts:138-172`), which is
   order-only and duration-agnostic. `xfade`/`acrossfade` are strictly
   pairwise with an absolute `offset` (relative to the first input), so
   the new code path: (a) ffprobes every normalized input's duration
   (`assembleClips.ts` does no ffprobe today — this is new); (b) walks the
   boundary list left to right, accumulating a running offset
   (`Σ durations so far − Σ overlaps so far`); (c) builds a sequential
   filter graph that alternates `xfade`/`acrossfade` pairs and `concat`
   segments depending on each boundary's type (a run of consecutive `cut`
   boundaries between two `xfade` joins can still concat as one segment;
   an `xfade` boundary joins exactly two streams at a time). Confirmed
   live and correct for a mixed cut+xfade 3-clip case:
   ```
   [v0][v1]xfade=transition=fade:duration=1:offset=2[vx];
   [a0][a1]acrossfade=d=1[ax];
   [vx][ax][v2][a2]concat=n=2:v=1:a=1[outv][outa]
   ```
   producing the arithmetically correct 8.06s from three 3s clips (one
   1s xfade, one cut). One accepted cosmetic risk from the same live run:
   `xfade` is frame-quantized and `acrossfade` is sample-quantized, so
   video and audio streams drift ~23ms apart per xfade boundary — harmless
   at the ≤7 boundaries this skill's 8-clip cap allows, not worth
   correcting for v1.
3. `trim_clip` — new orchestrator tool. One ffmpeg call, trims one
   uploaded clip to an in/out segment, produces a new `fileId`. Mirrors
   skill 5's `mux_beat_audio`: one focused ffmpeg operation per tool,
   its own credits helper file.
4. `GENERATION_APPROVAL_METADATA` — new entries for `trim-clip`/
   `trim_clip` (hyphenated + underscored, per skill 4/5's established
   rule — this map's own doc comment at `generationApproval.ts:75-84`
   explains why both forms are needed here specifically).
   `assemble-clips`/`assemble_clips` are already registered
   (`generationApproval.ts:115-116`).
5. `chatStream.ts`'s three hardcoded attachment lists (`:157`, the
   `SAVE_TOOL_NAMES` list at `:271`, the mirrored exclusion list at
   `:676`) — all three normalize tool names to hyphenated form before
   lookup (`resolvedToolName.toLowerCase().replace(/_/g, '-')` at
   `:675`), so only `'trim-clip'` (not the underscored form) needs adding,
   to all three, by hand — they are separately-typed literal arrays, not
   a shared constant. `assemble-clips` is already present in all three
   from skill 4. `attachmentFromCanvasToolResult` additionally requires
   the tool's result to carry a top-level `fileId` string — `trim_clip`'s
   output schema must too.
6. `directorAgent.ts`/`platformAgent.ts` — new
   `SHORT_DRAMA_STITCH_SECTION`/`SHORT_DRAMA_STITCH_CONTRACT`, following
   the established per-skill contract pattern. Both `directorAgent.ts:168`
   and `:187`'s literal `tools: {…}` maps (agent + delegate) get
   `trim_clip: trimClip` and `analyze_video`'s existing entry stays as-is
   (already registered from an earlier skill).
7. `credit-rates.ts` seed — one new subject row under the EXISTING
   `clip_assembly` resourceType: `ffmpeg-trim-clip`. No schema/migration
   needed (same as skill 5's four new `clip_assembly` subjects — this
   resourceType has no Postgres enum constraint — confirmed directly
   against `credits.ts:17-20` and migration `0069_mute_exodus.sql:41`,
   which emits a bare `text NOT NULL` with no `CREATE TYPE`/`CHECK`).

No new gateway route. No new vendor. No new resourceType.

## Hard Constraints

- **Length:** ~15-30 seconds, matching every other skill's ad-length norm.
- **Clip pool:** up to 8 uploaded clips considered; up to 8 selected
  segments assembled. `assemble_clips`'s `clipFileIds` cap is currently
  `.max(4)` (raised from 3 to 4 in skill 5) — this skill's work raises it
  to `.max(8)`. Skills 4/5 call with far fewer clips than 8 in practice,
  so this is a ceiling increase, not a behavior change for existing
  callers.
- **No generation.** This skill never calls `generate_image`/
  `generate_video`. If the user's footage can't support the ask (too few
  usable clips, wrong content), the Director says so and stops — it does
  not fill gaps with generated video.
- **Two selection modes**, both supported: (a) Director proposes a cut
  list from a footage pool via the extended `analyze_video` (real
  timestamps + duration, see above), user approves/edits; (b) user hands
  exact per-clip timestamps directly, skipping the AI-proposal step.
  Either path converges on the same approved cut-list shape before
  `trim_clip` runs.
- **Transitions are per-boundary, not per-clip.** `transitions.length`
  must equal `clips.length - 1`; the schema enforces this with a `.refine`
  on `assemble_clips`'s input, mirroring the existing `preserveAudio`/
  `targetDurationSeconds` mutual-exclusion `.refine`.
- **A zero-width transition is `type: 'cut'`, never an xfade with
  `overlapSeconds: 0`.** Verified live against real ffmpeg: video
  `xfade duration=0` silently drops the second clip entirely (exit 0, no
  error), and audio `acrossfade d=0` falls through to `nb_samples`'s
  ~0.92s default — the opposite of zero, and silently identical to
  omitting the field. Neither behavior is usable as "zero-length
  crossfade," so the schema forbids `overlapSeconds` on `type: 'cut'`
  entries and requires `overlapSeconds > 0` on `type: 'xfade'` entries
  (a `.refine`, not just a type default) — there is no valid zero value
  on the xfade branch at all.
- **A second `.refine` requires `preserveAudio: true` whenever
  `transitions` is set.** Without it, `transitions` passed with
  `preserveAudio` left at its `false` default would silently no-op into
  a plain concat instead of loudly rejecting — breaking this codebase's
  established convention that incompatible field combinations reject,
  they don't get ignored (the existing `preserveAudio`/
  `targetDurationSeconds` refine is the precedent).
- **Xfade requires uniform input geometry AND a duration probe.** Every
  clip is normalized first (same `fps=30,scale=...,pad=...` video-filter
  chain `assemble_clips` already applies per input, same
  `aresample=48000,aformat=...` audio normalization already applied under
  `preserveAudio` — confirmed live to tolerate mismatched source
  fps/resolution once normalized). Unlike the existing concat path,
  the transitions path also ffprobes every normalized input's duration
  (new — `assembleClips.ts` does no ffprobe today) to compute each
  boundary's absolute `xfade`/`acrossfade` offset; see "Extended" above
  for the confirmed-correct filter-graph shape.
- **Audio stack is fixed order, unchanged from skill 5:** preserve clip
  audio through assembly → transcribe → burn captions → generate music →
  mix music bed LAST. Music bed never precedes captions.
- **Caption/brand-name verification gate has a skill-7-specific
  referent.** Skill 5's version compares the transcript against the
  Director's own approved narration script — skill 7 never generates
  speech, so there is no script to compare against. This skill's gate
  instead: at intake, ask the user to confirm the exact spelling of any
  brand/product name that should appear in the footage's dialogue; after
  `transcribe_audio` runs, the Director (prose-level check, same
  mechanism as skill 5's — `burn_captions` itself has no comparison logic
  or mismatch refusal bucket in either skill, this is agent-instruction
  enforcement, not tool-code enforcement) flags any mismatch or absence
  against that confirmed spelling before proceeding to `burn_captions`.
- **Gates: exactly two.** (1) Cut-list approval (clips, order, trim
  points, transition choices) before any `trim_clip`/`assemble_clips`
  call. (2) Caption/brand-name check against the intake-confirmed
  spelling, described above. No board-of-stills gate — there is nothing
  generated to visually approve before it becomes real, uploaded footage
  already is.
- **`FFMPEG_TIMEOUT_MS` and `MAX_CLIP_BYTES` are raised, not inherited
  silently.** Both constants in `assembleClips.ts` (60s timeout, 200MB
  cap) were sized for skill 4/5's short generated clips. Skill 7 doubles
  the clip count to 8, always sets `preserveAudio: true`, adds an xfade
  chain, and takes real uploaded camera footage where a single clip well
  over 200MB is ordinary. This skill's implementation raises
  `FFMPEG_TIMEOUT_MS` to 180s (generous margin for an 8-clip 1080p xfade
  encode) and `MAX_CLIP_BYTES` to 500MB for this tool's inputs — both
  decided explicitly here rather than left at skill 4/5's defaults.

## Data flow

1. **Intake.** User uploads footage pool (multiple clip files via chat).
   Director asks target length (~15-30s, default 20s), story intent, and
   the exact spelling of any brand/product name expected in the dialogue
   (feeds the Phase 8 check).
2. **Selection.**
   - Mode A (AI-proposed): Director calls the extended `analyze_video`
     (mode: quick) per uploaded clip, getting back `durationSeconds` and
     timestamp-labeled beat descriptions, then proposes a cut list —
     which clip, approximate in/out timestamps, order, transition per
     boundary — sized to the target length.
   - Mode B (user-specified): user hands exact in/out timestamps and
     order directly; Director skips `analyze_video` and the proposal step.
   - Either path produces the same cut-list shape.
3. **Cut-list approval gate.** Full list shown — clip, trim points, order,
   transition per boundary — one stop, before any ffmpeg work starts.
4. **Trim.** One `trim_clip` call per selected segment (ffprobe-checked
   in/out against source duration first — Mode A's timestamps are
   approximate, so this probe is the real correctness backstop, not just
   defensive padding), producing a new `fileId` per trimmed segment.
5. **Assemble.** One `assemble_clips` call: `clipFileIds` = the trimmed
   segments in order, `preserveAudio: true`, `transitions` = the approved
   per-boundary list (ffprobed and offset-accumulated internally per the
   filter-graph shape above), `aspectRatio` per intake.
6. **Transcribe.** `transcribe_audio` on the assembled master.
7. **Captions.** `burn_captions` from the transcript.
8. **Caption/brand-name check.** Director compares the transcript against
   the spelling confirmed at intake; flags any mismatch or absence before
   proceeding (prose-level enforcement — see Hard Constraints).
9. **Music.** `generate_song` for an instrumental bed.
10. **Final mix.** `mix_music_bed` — last step, unchanged order from
    skill 5.
11. **Delivery.**

## Credits / charge discipline

- `trim_clip`: new subject `ffmpeg-trim-clip` under the existing
  `clip_assembly` resourceType. Charge-before-call (before the ffmpeg
  invocation), refund-after-failure, `chargeKey` from
  `execContext.agent.toolCallId`, `agentId` read as `string | undefined`
  — exact same shape as every other local-ffmpeg tool in this codebase
  (`assemble_clips`, skill 5's five tools). No schema migration: this
  resourceType has no Postgres enum constraint (confirmed during skill
  5's Task 1 review).
- `assemble_clips`: existing rate/subject (`clip_assembly`/`ffmpeg-local`)
  keeps gating and charging the transitions addition the same way it
  gates and charges today — same tool, same charge path, no new subject
  needed. (This rate was never sized to compute cost — per skill 5's own
  precedent it exists purely to keep every local-ffmpeg tool on the same
  charge/approval code path — so nothing about the xfade work changes
  what it needs to cover.)
- Seed row: `('clip_assembly', 'ffmpeg-trim-clip', { per_call_micro:
  1_000 })` — matches skill 5's four `clip_assembly` rows exactly.
- **Deploy prerequisite, not just a code change:** `shouldRequireApproval`
  returns `false` when `resolveRate` finds no matching row
  (`generationApproval.ts:32-35`), and `assembleClips.ts` proceeds
  unbilled with only a server log when no rate exists (`:100-102`). If
  `('clip_assembly', 'ffmpeg-trim-clip')` isn't seeded in the deployed
  DB, `trim_clip` runs completely free AND with no approval card shown —
  silently defeating gate 1's own enforcement mechanism, not just
  "unbilled." `pnpm db:seed` against the target environment is required
  before a live run, same lesson skill 5 documented and the same trap.

## Error handling

- `trim_clip`: `INVALID_TRIM_RANGE` refusal when requested in/out exceeds
  the source clip's ffprobe-reported duration (probe-before-trim, mirrors
  `composite_end_card`'s real-dimension-probe pattern from skill 5).
- `assemble_clips` transitions path: reuses `MISSING_AUDIO_STREAM` (already
  shipped) when a clip lacks audio under `preserveAudio: true`. New
  `TRANSITION_COUNT_MISMATCH` refusal (schema-level `.refine`) when
  `transitions.length !== clips.length - 1`. New `TRANSITION_REQUIRES_AUDIO`
  refusal (schema-level `.refine`) when `transitions` is set without
  `preserveAudio: true`. New `INVALID_TRANSITION_OVERLAP` refusal
  (schema-level `.refine`) when an `xfade` entry has `overlapSeconds <= 0`
  or a `cut` entry carries `overlapSeconds` at all. New
  `XFADE_FILTER_FAILED` refusal bucket, distinct from the generic
  `ASSEMBLY_FAILED`, for an xfade-specific ffmpeg stderr match — the exact
  match string is discovered and confirmed against a live ffmpeg run
  during implementation, not guessed in advance (same discipline skill
  5's `burn_captions` task followed for its `SUBTITLES_FILTER_UNAVAILABLE`
  string).
- All new/modified tools require live ffmpeg verification during
  implementation, with a negative control reproducing the pre-fix
  behavior — the standing rule from skills 4 and 5, restated because this
  skill's xfade work is new filter-graph territory with no existing
  passing test to build from.

## Testing

- `trim_clip`: schema-level `.safeParse()` tests (raw exported
  `inputSchema`, mirroring every other tool's now-standard pattern), live
  ffmpeg argv-assertion test, live ffmpeg run against a real short clip
  confirming output duration matches the requested trim window,
  `INVALID_TRIM_RANGE` refusal test against a real out-of-range request.
- `assemble_clips` transitions addition: live ffmpeg run with 3 clips and
  a mix of `cut` and `xfade` boundaries (the confirmed-correct filter
  shape from "Extended" above), confirming (a) total output duration
  accounts for crossfade overlap shortening the naive sum, matching the
  live-verified 8.06s/three-3s-clips/one-1s-xfade result; (b) an
  `xfade` entry with `overlapSeconds: 0` or omitted is rejected by the
  schema, not silently accepted (negative control: assert the live
  ffmpeg behavior this schema rule exists to prevent — video `xfade
  duration=0` drops the second clip entirely, audio `acrossfade d=0`
  falls through to a ~0.92s default — would otherwise reach ffmpeg); (c)
  `TRANSITION_COUNT_MISMATCH`, `TRANSITION_REQUIRES_AUDIO`, and
  `INVALID_TRANSITION_OVERLAP` each fire on their respective bad input.
- Director/platform contract tests: tool registration on both
  `directorAgent`/`directorAgentDelegate`, routing-disambiguation test
  confirming Olmo does not confuse this skill's contract with skill 5's
  (both can involve "stitching clips," but skill 5 generates its own
  footage first and skill 7 never generates video at all — the contract
  text needs an explicit mutual-exclusion clause, same pattern as skills
  4/5's photoreal-vs-stylized disambiguation).

No open questions — all decisions above were made in chat before this
document was written.
