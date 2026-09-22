# short-drama-stitch skill — design

Date: 2026-09-22
Status: approved in chat, pending self-review + user review of this file

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
- `analyze_video` — already exists, already gateway-routed
  (`gemini-3.6-flash` via `/v1/chat/completions`), returns a quick/deep
  text summary of a video's content per clip. Used to help the Director
  propose which segments of the uploaded pool make a compelling cut.
- `transcribe_audio`, `burn_captions`, `generate_song`, `mix_music_bed` —
  all shipped in skill 5, used here completely unchanged, same call
  shapes, same pipeline position (captions before music, music bed last).
- `assemble_clips` — already explicitly described in its own code comment
  as "shared infra for talking-head, short-drama-stitch, and
  animation-character" (`assembleClips.ts:55`), anticipating this reuse.

**New this skill:**
1. `trim_clip` — new orchestrator tool. One ffmpeg call, trims one
   uploaded clip to an in/out segment, produces a new `fileId`. Mirrors
   skill 5's `mux_beat_audio`: one focused ffmpeg operation per tool,
   its own credits helper file.
2. `assemble_clips` — extended, not replaced. `clipFileIds` cap raised
   `.max(4)` → `.max(8)`. New optional `transitions`
   parameter: an array of per-boundary `{ type: 'xfade' | 'cut', name?:
   string, overlapSeconds?: number }` entries (length = clips.length - 1),
   consumed only when `preserveAudio: true` (short-drama-stitch always
   sets this — footage keeps its own audio). Cut boundaries with no
   crossfade still concat as today.
3. `GENERATION_APPROVAL_METADATA` — new entries for `trim-clip`/
   `trim_clip` (hyphenated + underscored, per skill 4/5's established
   rule). `assemble-clips`/`assemble_clips` are already registered.
4. `chatStream.ts`'s three hardcoded attachment lists — `trim-clip`
   produces a `fileId` and must be added to all three (the allowlist, the
   `SAVE_TOOL_NAMES` list, and the mirrored exclusion list), the exact
   class of bug skill 5's final review caught as a Critical repeat.
   `assemble-clips` is already present in all three from skill 4.
5. `directorAgent.ts`/`platformAgent.ts` — new
   `SHORT_DRAMA_STITCH_SECTION`/`SHORT_DRAMA_STITCH_CONTRACT`, following
   the established per-skill contract pattern.
6. `credit-rates.ts` seed — one new subject row under the EXISTING
   `clip_assembly` resourceType: `ffmpeg-trim-clip`. No schema/migration
   needed (same as skill 5's four new `clip_assembly` subjects — this
   resourceType has no Postgres enum constraint).

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
  list from a footage pool via `analyze_video`, user approves/edits; (b)
  user hands exact per-clip timestamps directly, skipping the AI-proposal
  step. Either path converges on the same approved cut-list shape before
  `trim_clip` runs.
- **Transitions are per-boundary, not per-clip.** `transitions.length`
  must equal `clips.length - 1`; the schema enforces this with a `.refine`
  on `assemble_clips`'s input, mirroring the existing `preserveAudio`/
  `targetDurationSeconds` mutual-exclusion `.refine`.
- **`overlapSeconds: 0` is a valid, distinct value from "omitted."** An
  entry with `type: 'cut'` never carries `overlapSeconds`; an entry with
  `type: 'xfade'` and `overlapSeconds: 0` is a zero-length crossfade
  (visually a hard cut but still routed through the xfade filter graph)
  and must not be coerced to any nonzero default. This is the exact
  falsy-vs-absent gotcha `combine_video.py` guards against.
- **Xfade requires uniform input geometry.** Before building the filter
  graph, every clip is normalized (same `fps=30,scale=...,pad=...`
  video-filter chain `assemble_clips` already applies per input, same
  `aresample=48000,aformat=...` audio normalization already applied under
  `preserveAudio`) — xfade fails unpredictably on mismatched geometry
  otherwise. This is not new work; it reuses the exact per-input filter
  chains already in `assembleClips.ts:138-153`, just feeds their outputs
  through `xfade`/`acrossfade` instead of `concat` when a boundary calls
  for it.
- **Audio stack is fixed order, unchanged from skill 5:** preserve clip
  audio through assembly → transcribe → burn captions → generate music →
  mix music bed LAST. Music bed never precedes captions.
- **Caption/brand-name verification gate reused as-is** from skill 5 —
  hard block on transcript mismatch, same tool (`burn_captions` consumes
  the same `transcribe_audio` output shape).
- **Gates: exactly two.** (1) Cut-list approval (clips, order, trim
  points, transition choices) before any `trim_clip`/`assemble_clips`
  call. (2) Caption/brand-name verification gate, reused unchanged from
  skill 5. No board-of-stills gate — there is nothing generated to
  visually approve before it becomes real, uploaded footage already is.

## Data flow

1. **Intake.** User uploads footage pool (multiple clip files via chat).
   Director asks target length (~15-30s, default 20s) and story intent.
2. **Selection.**
   - Mode A (AI-proposed): Director calls `analyze_video` (mode: quick)
     per uploaded clip, then proposes a cut list — which clip, in/out
     timestamps, order, transition per boundary — sized to the target
     length.
   - Mode B (user-specified): user hands exact in/out timestamps and
     order directly; Director skips `analyze_video` and the proposal step.
   - Either path produces the same cut-list shape.
3. **Cut-list approval gate.** Full list shown — clip, trim points, order,
   transition per boundary — one stop, before any ffmpeg work starts.
4. **Trim.** One `trim_clip` call per selected segment (ffprobe-checked
   in/out against source duration first), producing a new `fileId` per
   trimmed segment.
5. **Assemble.** One `assemble_clips` call: `clipFileIds` = the trimmed
   segments in order, `preserveAudio: true`, `transitions` = the approved
   per-boundary list, `aspectRatio` per intake.
6. **Transcribe.** `transcribe_audio` on the assembled master.
7. **Captions.** `burn_captions` from the transcript.
8. **Caption/brand-name verification gate.** Hard block on mismatch
   (reused unchanged from skill 5).
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
  covers the transitions addition — same tool, same charge path, no new
  subject needed. The xfade filter graph work happens inside the same
  single ffmpeg call the tool already charges for once.
- Seed row: `('clip_assembly', 'ffmpeg-trim-clip', { per_call_micro:
  1_000 })` — matches skill 5's four `clip_assembly` rows exactly.

## Error handling

- `trim_clip`: `INVALID_TRIM_RANGE` refusal when requested in/out exceeds
  the source clip's ffprobe-reported duration (probe-before-trim, mirrors
  `composite_end_card`'s real-dimension-probe pattern from skill 5).
- `assemble_clips` transitions path: reuses `MISSING_AUDIO_STREAM` (already
  shipped) when a clip lacks audio under `preserveAudio: true`. New
  `TRANSITION_COUNT_MISMATCH` refusal (schema-level `.refine`, same
  pattern as the existing `preserveAudio`/`targetDurationSeconds` refine)
  when `transitions.length !== clips.length - 1`. New
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
  a mix of `cut` and `xfade` boundaries, confirming (a) total output
  duration accounts for crossfade overlap shortening the naive sum, (b)
  an `overlapSeconds: 0` xfade entry does not silently become a default
  overlap (negative control: assert it differs from an entry with no
  `overlapSeconds` field at all, which the schema should reject rather
  than default), (c) `TRANSITION_COUNT_MISMATCH` fires on a mismatched
  array length.
- Director/platform contract tests: tool registration on both
  `directorAgent`/`directorAgentDelegate`, routing-disambiguation test
  confirming Olmo does not confuse this skill's contract with skill 5's
  (both can involve "stitching clips," but skill 5 generates its own
  footage first and skill 7 never generates video at all — the contract
  text needs an explicit mutual-exclusion clause, same pattern as skills
  4/5's photoreal-vs-stylized disambiguation).

No open questions — all decisions above were made in chat before this
document was written.
