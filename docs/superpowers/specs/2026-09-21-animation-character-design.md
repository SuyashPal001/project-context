# animation-character skill — design

Date: 2026-09-21
Status: revised after Opus architectural review round 1 — pending user review

## Revision note (round 1)

An architectural review, before implementation planning, checked the
first draft's reuse claims against the real shipped code from skill 4
rather than taking them on faith. Two things held up (`generate_image`
reference-chaining, `generate_video` start-image conditioning) and the
Gemini-transcription-through-the-gateway routing was correct from the
start — skill 4's own landmine (vendor calls bypassing
`apps/inference-gateway`) was NOT repeated. But seven real gaps
surfaced, all now folded in below:

1. `assemble_clips` caps input at 3 clips (`assembleClips.ts:40`,
   `.max(3)`) — the fixed 4-beat requirement needs 4.
2. `assemble_clips` strips ALL audio (`-an`) and has no audio input at
   all — because skill 4's actual flow concatenates SILENT clips first
   and runs `lipsync` once, afterward, against the whole assembled
   video and one full-length narration track. Nothing in the codebase
   muxes or mixes audio onto individual clips. This skill's flow is
   structurally different (one lip-synced hook beat, three separately
   narrated beats, no single whole-video lipsync pass) and needs real
   new audio-handling infra.
3. Direct consequence of #2: the first draft would have discarded the
   hook beat's lip-synced audio at the assembly step.
4. `targetDurationSeconds` is one global trim target, not a per-clip
   one — the "trim each beat to its own VO length" rule needs per-clip
   control `assemble_clips` doesn't have.
5. No orchestrator tool exposed the gateway's transcript to the agent
   — the caption/brand-name verification gate needs one.
6. `GENERATION_APPROVAL_METADATA` registration was never mentioned for
   any new tool — skill 4's own documented silent-crash mode if
   skipped.
7. New charge-bearing capabilities need concrete `resourceType`/
   `subject`/rate-row decisions, not "Gemini-priced" hand-waving.

The fix restructures Phase 0 into six new/modified pieces instead of
three, reorders the pipeline to mux and trim audio per-beat BEFORE
concatenation (rather than after, the way skill 4 does it), and
follows novoads' own fixed gate order for the tail of the pipeline
(end card → concat/voice-mix → transcribe → captions → **music bed
last**, laid after captions, never before) — a detail the first draft
got backwards by planning the music bed before transcription.

## Problem

`apps/agent-orchestrator` can clone a template (skill 1), build a
multi-beat photoreal UGC storyboard (skill 2, with skill 3's
motion-craft rules layered on top), and generate a single continuous
photoreal presenter speaking to camera (skill 4, talking-head). This
is skill 5 of 7: a **stylized, animated, story-driven** ad — a
character-and-arc format distinct from both UGC skills (photoreal,
person-holds-product) and talking-head (photoreal, single presenter,
no story arc). Think a 30-second animated short film selling a
product, not a spokesperson or a testimonial.

## Research basis

novoads' `pixar-ad` skill (`SKILL.md`, 1123 lines, plus
`references/formulas.md`) was read in full for this spec — a
production skill serving real animated-ad traffic on novoads' own
vendor stack (Seedance video, gpt-image-2 stills, their own
voiceover/music/caption/transcript endpoints). It is the primary
source; see [[project_creative_skills_research_status]] for the
research-lock decision. Its core craft findings, translated into our
stack below:

- **Stills-first, board-gated pipeline.** Every beat gets a still image
  BEFORE any clip renders, chained off a single cast-sheet reference
  image, with one hard stop (board gate) for human approval before any
  clip is spent. Rationale, stated directly in the source: clips are
  "most of the bill," a still is "a small fraction of the clip it
  seeds" — the gate exists because a wrong character/palette/location
  is cheapest to catch here.
- **One continuous voice, one beat that actually speaks.** Narration
  goes through a VO track for most beats (so one voice persists across
  separately-rendered clips); at least one beat must have the
  character audibly speak its own line, or the ad reads as a slideshow
  with narration over it. Never both VO and in-clip speech on the same
  beat (doubles the line).
- **Cast-sheet + terse-tag + style-lock discipline.** A single
  reference image anchors character design across beats; a short
  wardrobe-anchored phrase (the "terse tag") is repeated verbatim in
  every beat prompt; a style-lock paragraph (palette, light source,
  lens, render vocabulary) is pasted unchanged into every prompt.
  Reworded style-lock text between beats is the source's most-cited
  cause of grade drift.
- **Product treatment doctrine.** Doctrine C (in-world recreation, real
  product photo composited only on the end card, never AI-rendered) is
  the safe default — the source's own failure log shows wordmarks
  reliably garbling when the model is asked to draw them
  ("Novoads.ai" rendered as "Novads.ai", "Owala" as "ovola").
- **Trim-to-narration, never speed up audio.** Each beat's clip is
  trimmed to its VO length + 0.5s of air, not the reverse. A VO line
  longer than its clip gets a longer re-render or a split line, never
  `atempo` speed-up.
- **Fixed gate order for the tail of the pipeline**: end card
  composited → clips concatenated with their voice mixed in → the
  master transcribed → captions burned from that transcript → **the
  music bed laid last**, after captions, never before. novoads is
  explicit that hand-laying the bed earlier or at a guessed volume is
  how a bed ends up inaudible or unchecked.
- **Captions are transcribed, not assumed.** Captions burned from a
  fresh transcription of the actual rendered/mixed audio, not from the
  original script — because voice models can drop or add words, and
  because it catches the one failure mode that ships broken ads
  silently: a doubled or garbled brand name in the caption track,
  distinct from and in addition to spoken-audio QA on the clips
  themselves.

## What we build vs. what we reuse

Skill 4's Phase 0 build already gave us narration, lip-sync, and
ffmpeg-based concatenation — but skill 4's own pipeline shape (concat
SILENT clips first, run one lip-sync pass afterward against the whole
video and a single full-length narration track) does not fit this
skill's structure: one lip-synced hook beat plus three separately
narrated beats, each needing its own audio muxed and trimmed before
the clips are joined. That difference is what drives the real new
scope below.

**Reused as-is, no changes:**
- `generate_image` (skills 1/2) — cast sheet + chained per-beat stills
  via reference-image conditioning (`referenceFileIds`, max 3,
  `identityAnchor` enforced) — verified against shipped code, this
  claim holds.
- `generate_video` (skill 1) — silent per-beat clips, start-image
  conditioned via `animate_frame` — verified, holds.
- `generate_song` (skill 1) — music bed generation (not placement —
  placement is new, see below).
- `generate_narration` (skill 4) — VO lines for beats 2-4,
  Cartesia-backed, unchanged.

**Reused with a one-line description change:**
- `lipsync` (skill 4) — used for exactly one beat (the hook), not the
  whole assembled video. Its current tool description
  (`lipsync.ts:39`) says "never per-clip," written for skill 4's own
  whole-video-pass usage. That line needs editing to allow a single
  named beat within a multi-beat board — the underlying vendor call
  and credit/approval logic are unchanged, only the description and
  the directorAgent instruction text calling it need updating for this
  skill's usage.

**Modified — new capability added to an existing tool:**
- `assemble_clips` (skill 4) — two additive, backward-compatible
  changes:
  - Raise `clipFileIds` from `.max(3)` to `.max(4)`.
  - Add an optional `preserveAudio: boolean` field (default `false`,
    so skill 4's and skill 7's existing silent-concat-then-lipsync
    callers are unaffected). When `true`, the ffmpeg filter graph maps
    each input's audio stream alongside video and concatenates both
    (`concat=n=…:v=1:a=1`) instead of appending `-an`. Also add an
    optional `perClipTrimSeconds: number[]` (parallel to
    `clipFileIds`, one entry per clip, each clip individually trimmed
    via its own `-t`/`tpad` before the shared concat filter runs) —
    this skill passes it; skill 4/7 callers that don't need per-clip
    trimming leave it unset and keep using the existing global
    `targetDurationSeconds`.

**New Phase 0 orchestrator tools:**

1. **`mux_beat_audio`** — takes one silent beat clip + one narration
   audio file (a VO line from `generate_narration`), muxes the audio
   onto the clip, and trims the clip to `audio duration + 0.5s`
   (ffmpeg, following `media.ts`'s `execFile`-with-timeout pattern,
   same charge-before-call/refund-after-failure discipline as
   `assembleClips.ts`). Used for beats 2-4 only — the hook beat's
   `lipsync` output is already audio-bearing and correctly timed, so
   it skips this step and goes straight into assembly.
2. **`transcribe_audio`** — orchestrator tool wrapping the new
   `POST /v1/audio/transcribe` gateway route (see below), following
   `generateNarration.ts`'s shape (charge-before-call, refund on
   failure, raw Zod `inputSchema` exported separately per skill 4's
   standing type-check lesson). This is distinct from the existing
   `analyze_audio` tool, which transcribes via the gateway's
   `/v1/chat/completions` path with no word-level timings — not
   reusable here because the caption-burn step needs real per-word
   timestamps, which `analyze_audio` does not return.
3. **`mix_music_bed`** — takes the captioned master + a music bed
   (from `generate_song`), ducks the bed under the existing voice
   track, masters it, and — following novoads' own measured caution
   about a bed rendered inaudible by an unchecked multiplier — runs a
   loudness check (`ffmpeg … loudnorm` / `ebur128`) before finalizing,
   refusing rather than shipping a bed nobody would actually hear.
   Applied LAST in the pipeline, after captions, per the fixed gate
   order above.
4. **`burn_captions`** — local ffmpeg (`drawtext`/ASS overlay,
   `media.ts`'s `execFile` pattern, no new binary dependency). Takes
   the voice-mixed master + the transcript's word timings from
   `transcribe_audio`, burns one fixed caption style (heavy
   sans-serif, white fill, dark outline, lower third, phrase-grouped
   — matching the genre look the source describes; no preset system,
   one hardcoded style for v1).
5. **`composite_end_card`** — local ffmpeg overlay. Takes beat 4's
   muxed clip (after `mux_beat_audio`, before assembly — "card BEFORE
   the concat," per the source) + the real product photo, composites
   the real photo over the render at the beat's own scene cut
   (dissolve, not hard cut), matched in scale to the rendered
   product's bounding box.

**New inference-gateway route:**

- **`POST /v1/audio/transcribe`** — vendor: **Gemini**, via the
  existing Vertex/Gemini client already used for image/video
  generation (no new vendor account, no new secret). Takes an
  uploaded audio/video asset, returns structured JSON: `{ text:
  string, words: [{ word: string, startSeconds: number, endSeconds:
  number }] }`, schema-validated (Zod) against Gemini's structured
  output, not parsed as free text — a response failing the schema is
  a hard error, not a best-effort parse.

## Hard constraints (carried from research, locked with the user)

- **4 fixed beats, 30 seconds total max.** No variable beat count.
  Matches skill 4's own 15-30s ad-length ceiling reasoning ("I have
  not seen any video above 45 seconds on Instagram/Shorts").
- **Beat roles are fixed, not chosen per-ad:**
  1. **Hook** — the character states its want/problem out loud.
     **This is the one lip-synced beat** — `lipsync` runs on this
     beat's clip alone, immediately after its VO line is generated.
     Skips `mux_beat_audio` (already audio-bearing).
  2. **Low point** — the private defeat/lowest moment. VO track via
     `generate_narration` → `mux_beat_audio`.
  3. **Turn** — the product arrives and is used. VO track, same as
     above.
  4. **Payoff** — warmth, then the CTA and the composited end card. VO
     track, same as above; `composite_end_card` runs on this beat's
     muxed clip before assembly.
- **Style is a user-facing input, one of exactly three enum values —
  no freeform style text:**
  - `3d_pixar` — stylized 3D animated feature-film look (the source's
    own style-lock template, adapted: warm palette, subsurface
    scattering, large expressive eyes, mid-emotion rule).
  - `2d_flat` — flat vector/illustration look (bold color blocks,
    simple line work, no gradients).
  - `claymation` — stop-motion clay look (visible material texture,
    imperfect surfaces, subtle per-frame jitter in the prompt
    vocabulary).
  Each style owns its own style-lock paragraph + negative-block
  template (see Task-level detail in the implementation plan); the
  pipeline mechanics (board gate, VO/SYNC split, trim rule, caption
  burn, end-card composite) are identical across all three.
- **Doctrine C only.** No Doctrine D (product-as-character) in v1 —
  every product is recreated in-style for in-world use, with the real
  photo composited only on the end card.
- **One continuous voice.** One `voiceId` (Cartesia) selected once per
  ad, reused for every VO line across beats 1-4 (the hook beat's
  lip-sync line uses the same `voiceId` as the VO beats).
- **Never both VO and in-clip speech on the same beat.** The hook beat
  gets lip-sync and no separate VO call beyond the one line fed into
  `lipsync`; beats 2-4 get VO and their `generate_video` prompts state
  explicitly that the shot has no speech.
- **Trim to narration, not the reverse, per beat.** Each beat's clip
  is trimmed to its own audio length + 0.5s via `mux_beat_audio` (or,
  for the hook beat, whatever length `lipsync` produces); if VO is
  longer than its beat's clip, re-render the clip longer or split the
  line — never speed up audio.
- **Board gate is one stop, not five.** All 5 images (cast sheet + 4
  beat stills) shown together for one approval; per-image approval one
  at a time is explicitly wrong (the operator is judging beat-to-beat
  continuity, not individual stills).
- **End card is composited, never rendered.** The model does not draw
  the product photo or wordmark on the final beat; the real photo is
  overlaid via `composite_end_card` before assembly.
- **Music bed is laid last, after captions, never before.** Matches
  novoads' fixed gate order exactly — a bed laid earlier and burned
  under captions risks an unheard or unchecked mix.
- **Captions block the ship on a garbled brand/product name or price.**
  Same rule as the source: this is a hard gate, not a note in a
  report. If the transcript-derived caption text misrenders the brand
  name, the flow must re-run the transcription/caption step (or fall
  back to keeping the brand name off narration and on the end card
  only, per the source's own preferred fix) before delivering.

## Data flow

```
 1. Product read + Gate 0 style fit (emotional/relational pain, not
    a spec pitch) → confirm with user which of the 3 styles to use
 2. Cast sheet (generate_image, style-lock + terse-tag template)
 3. 4 chained beat stills (generate_image, each referencing cast
    sheet + previous still)
    → BOARD GATE: show all 5 images together, wait for approval
 4. 4 silent beat clips (generate_video, one call per beat,
    start-image-conditioned on that beat's approved still)
 5. Beat 1 (hook): generate_narration (one short line) → lipsync
    (beat 1 clip + that narration) → audio-bearing, correctly-timed
    hook clip
    Beats 2-4: generate_narration (one VO line each, same voiceId)
    → mux_beat_audio (beat clip + VO line) → audio-bearing,
    trimmed-to-VO+0.5s clip, one call per beat
 6. composite_end_card on beat 4's muxed clip (real product photo
    overlay, before assembly)
 7. assemble_clips(preserveAudio=true, 4 already-trimmed
    audio-bearing clips in beat order, no targetDurationSeconds
    needed) → voice-mixed master
 8. Upload the master → transcribe_audio (wraps POST
    /v1/audio/transcribe, Gemini) → word-level timings
 9. burn_captions (master + transcript timings, fixed style)
10. Caption verification: transcript text checked against the
    original script for the brand/product name and any spoken price
    — block delivery on a mismatch, per the hard constraint above
11. generate_song → music bed
12. mix_music_bed (captioned master + music bed, ducked/mastered/
    loudness-checked) → final master
13. Deliver final MP4
```

## Credits / charge discipline

Every new charge-bearing call follows skill 4's established pattern
(`generateVideo.ts` is the canonical shape): charge BEFORE the
gateway/vendor call, refund AFTER any post-charge failure,
`chargeKey` derived from `execContext.agent.toolCallId`.

**Concrete `resourceType`/`subject`/rate rows:**

- **`audio_transcription`** — genuinely new `resourceType` enum value
  (`packages/foundation/database/schema/credits.ts:18` needs this
  value added to the `text(...).enum([...])` list, followed by
  `drizzle-kit generate` + migration). Subject: `gemini-transcribe`.
  Priced flat per call (matching every other row's `per_call_micro`
  shape — no existing row uses per-token/per-duration pricing, and
  this skill does not introduce one either) rather than a
  duration-scaled rate, to stay consistent with the rest of the
  schema.
- **`clip_assembly`** (existing enum value, no schema change) — four
  NEW subject rows, seed-only, no migration:
  - `ffmpeg-mux-audio` (for `mux_beat_audio`)
  - `ffmpeg-composite-end-card` (for `composite_end_card`)
  - `ffmpeg-burn-captions` (for `burn_captions`)
  - `ffmpeg-mix-music-bed` (for `mix_music_bed`)
  - `assemble_clips`'s own existing `ffmpeg-local` subject/rate is
    reused unchanged for its `preserveAudio`/`perClipTrimSeconds`
    additions — same tool, same rate row, no new subject needed.

**Approval-gate registration** (`generationApproval.ts`,
`GENERATION_APPROVAL_METADATA`): every new multi-word tool id needs
BOTH the hyphenated (tool `id`) and underscored (delegate-map-key)
forms registered, per skill 4's own documented silent-crash mode
(`resumeStream()` cannot resume an unregistered tool call). This
applies to `mux-beat-audio`/`mux_beat_audio`,
`transcribe-audio`/`transcribe_audio`, `mix-music-bed`/
`mix_music_bed`, `burn-captions`/`burn_captions`,
`composite-end-card`/`composite_end_card` — five tools, ten entries.
Each needs its own refund helper following `assemblyCredits.ts`'s
shape.

## Error handling / QA gates

- **Per-still board gate** (Section above) — one stop before any clip
  spend.
- **Per-clip QA**, mirroring the source: same character as cast sheet,
  one action only, no extra limbs/eyes, product details/label legible,
  clip's own audio usable. A failing clip is re-rendered from its
  still (cheap); a failing still is re-rendered from the cast sheet
  (cheaper still) — never silently proceed with a bad beat.
- **Caption/transcript gate** — hard block on a garbled brand name or
  spoken price, as stated in Hard Constraints.
- **End-card composite check** — bounding-box scale match between the
  rendered product and the real photo verified before compositing;
  background color sampled and matched to avoid a visible seam.
- **Music-bed loudness check** — `mix_music_bed` refuses to finalize a
  bed measured inaudible (an unchecked multiplier producing, e.g.,
  -33 to -40 dB) rather than shipping a paid-for bed nobody hears.

## Testing

Matches skill 4's testing shape: unit tests for each new ffmpeg tool
(`mux_beat_audio`, `composite_end_card`, `burn_captions`,
`mix_music_bed`) mocking `execFile` exactly like
`assembleClips.test.ts`, including a live-ffmpeg-execution check (not
just a mocked-`execFile` check) for any filter-graph change — skill
4's `-vf`/`-filter_complex` bug shipped invisibly past a
mocked-`execFile` test suite and was only caught by actually running
ffmpeg; the same discipline applies to `assemble_clips`'s new
`preserveAudio`/`perClipTrimSeconds` filter-graph paths and to every
new tool's ffmpeg invocation. Unit tests for the new
`/v1/audio/transcribe` gateway route asserting outbound request shape
and schema-validated response parsing (mirroring `speech.test.ts`'s
pattern from skill 4, including a negative-control case for a
malformed Gemini response). A `directorAgent.test.ts` addition
confirming `animation-character`'s tools are registered on both
`directorAgent` and `directorAgentDelegate`, and that the new
`ANIMATION_CHARACTER_SECTION` text is present in instructions.

## Open questions carried into planning

None — all scope decisions were confirmed with the user during
brainstorming (style enum, beat count, Doctrine C only, hook-beat
lip-sync reuse, captions in v1 scope, Gemini for transcription), and
the round-1 architectural gaps found by review are now folded into
this document. The implementation plan should treat this spec as
complete.
