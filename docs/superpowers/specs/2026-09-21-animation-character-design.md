# animation-character skill — design

Date: 2026-09-21
Status: approved by user in brainstorming dialogue — ready for planning

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
- **Captions are transcribed, not assumed.** Captions burned from a
  fresh transcription of the actual rendered/mixed audio, not from the
  original script — because voice models can drop or add words, and
  because it catches the one failure mode that ships broken ads
  silently: a doubled or garbled brand name in the caption track,
  distinct from and in addition to spoken-audio QA on the clips
  themselves.

## What we build vs. what we reuse

Unlike skill 4, this skill has almost no infrastructure gap — skill
4's Phase 0 build already gave us narration, lip-sync, and ffmpeg
assembly. The gap here is two small new ffmpeg-only capabilities plus
one new Gemini-based transcription route.

**Reused as-is, no changes:**
- `generate_image` (skills 1/2) — cast sheet + chained per-beat stills
  via reference-image conditioning, already supports this exact
  chaining pattern.
- `generate_video` (skill 1) — silent per-beat clips.
- `generate_song` (skill 1) — music bed.
- `generate_narration` (skill 4) — VO lines for non-hook beats,
  Cartesia-backed.
- `lipsync` (skill 4) — reused for exactly one beat (the hook), see
  below.
- `assemble_clips` (skill 4) — stitch/trim/concat.

**New Phase 0 infra (this skill's actual scope):**

1. **`POST /v1/audio/transcribe`** — new inference-gateway route.
   Vendor: **Gemini** (via the existing Vertex/Gemini client already
   used for image/video generation — no new vendor account, no new
   secret). Takes an uploaded audio/video asset, returns structured
   JSON: `{ text: string, words: [{ word: string, startSeconds:
   number, endSeconds: number }] }`. Response is schema-validated
   (Zod), not parsed as free text — Gemini is prompted to return
   exactly this JSON shape via structured output, and a response that
   fails the schema is a hard error, not a best-effort parse.
2. **`burn_captions`** orchestrator tool — new, local ffmpeg
   (`drawtext`/ASS overlay, following `media.ts`'s existing
   `execFile`-with-timeout pattern, no new binary dependency). Takes
   the assembled master + the transcript's word timings, burns one
   fixed caption style (heavy sans-serif, white fill, dark outline,
   lower third, phrase-grouped not word-by-word — matching the genre
   look the source describes; no preset system, one hardcoded style
   for v1).
3. **`composite_end_card`** orchestrator tool — new, local ffmpeg
   overlay. Takes the final beat's rendered frame + the real product
   photo, composites the real photo over the render at the point of
   the beat's own scene cut (dissolve, not hard cut), matched in scale
   to the rendered product's bounding box. Runs BEFORE assembly's
   concat step, on the final beat only.

## Hard constraints (carried from research, locked with the user)

- **4 fixed beats, 30 seconds total max.** No variable beat count.
  Matches skill 4's own 15-30s ad-length ceiling reasoning ("I have
  not seen any video above 45 seconds on Instagram/Shorts").
- **Beat roles are fixed, not chosen per-ad:**
  1. **Hook** — the character states its want/problem out loud.
     **This is the one lip-synced beat** — reuse skill 4's `lipsync`
     tool here specifically, nowhere else in this skill.
  2. **Low point** — the private defeat/lowest moment. VO track.
  3. **Turn** — the product arrives and is used. VO track.
  4. **Payoff** — warmth, then the CTA and the composited end card. VO
     track, closes the ad.
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
  ad, reused for every VO line across beats 2-4.
- **Never both VO and in-clip speech on the same beat.** The hook beat
  gets lip-sync and no VO; beats 2-4 get VO and their prompts state
  explicitly that the shot has no speech.
- **Trim to narration, not the reverse.** Each VO-driven beat's clip
  is trimmed to `VO duration + 0.5s`; if VO is longer than the clip,
  re-render longer or split the line — never speed up audio.
- **Board gate is one stop, not five.** All 5 images (cast sheet + 4
  beat stills) shown together for one approval; per-image approval one
  at a time is explicitly wrong (the operator is judging beat-to-beat
  continuity, not individual stills).
- **End card is composited, never rendered.** The model does not draw
  the product photo or wordmark on the final beat; the real photo is
  overlaid via ffmpeg.
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
5. Hook beat: generate_narration (short line) → lipsync (hook clip
   + that narration) → lip-synced hook clip
   Beats 2-4: generate_narration (one VO line per beat, same voiceId)
6. generate_song → music bed
7. composite_end_card (final beat's clip + real product photo)
8. assemble_clips (trim each beat to its VO/lipsync-audio length +
   0.5s, concat, mix voice + clip ambience + music bed)
9. Upload assembled master → POST /v1/audio/transcribe (Gemini) →
   word-level timings
10. burn_captions (master + transcript timings, fixed style)
11. Caption verification: transcript text checked against the
    original script for the brand/product name and any spoken price
    — block delivery on a mismatch, per the hard constraint above
12. Deliver final MP4
```

## Credits / charge discipline

Every new charge-bearing call follows skill 4's established pattern
(`generateVideo.ts` is the canonical shape): charge BEFORE the
gateway/vendor call, refund AFTER any post-charge failure,
`chargeKey` derived from `execContext.agent.toolCallId`. This applies
to the two new orchestrator tools (`burn_captions`,
`composite_end_card` — both are local ffmpeg, so their "charge" is a
small flat compute-cost row, same shape as skill 4's
`clip_assembly`/`ffmpeg-local` rate) and to the new gateway route
(`POST /v1/audio/transcribe`, a new `resourceType` row, Gemini-priced
per the actual token/audio-duration cost Gemini bills).

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

## Testing

Matches skill 4's testing shape: unit tests for the two new ffmpeg
tools (`burn_captions`, `composite_end_card`) mocking `execFile`
exactly like `assembleClips.test.ts`; unit tests for the new
`/v1/audio/transcribe` gateway route asserting outbound request shape
and schema-validated response parsing (mirroring `speech.test.ts`'s
pattern from skill 4, including a negative-control case for a
malformed Gemini response); a `directorAgent.test.ts` addition
confirming `animation-character`'s tools are registered on both
`directorAgent` and `directorAgentDelegate`, and that the new
`ANIMATION_CHARACTER_SECTION` text is present in instructions.

## Open questions carried into planning

None — all scope decisions were confirmed with the user during
brainstorming (style enum, beat count, Doctrine C only, hook-beat
lip-sync reuse, captions in v1 scope, Gemini for transcription). The
implementation plan should treat this spec as complete.
