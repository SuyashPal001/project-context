# TVC Part 2.1: the Legal Disclaimer (Design)

Status: draft for review. Scope A only, chosen by the user on 2026-10-07: the disclaimer. Animated text, the logo and the veg mark come later.
Branch: `text-overlay-legal`, from origin/main d86c0112.

## 1. Goal

Every TVC disclaimer follows the ASCI rules by construction, in tool code. Director only says which claim needs which disclaimer. The code decides size, box, timing, lines and sync. Text is never generated into images or video. It is composited onto the finished video by `overlay_text` (libass/ASS subtitles through ffmpeg), so every letter is exact and an edit is a cheap re-run.

The source of the rules is ASCI, "Guidelines for Disclaimers", amended 13 July 2023 (memory: reference_asci_disclaimer_rules).

## 2. What exists today, and what breaks the rules

| Today | Problem |
|---|---|
| `plan.legal: { text, startSeconds }[]`; Director writes the start time | No link to the claim it explains, so no voiceover sync |
| `legalHoldSeconds = max(4, words/5 + 3)` | Over-holds short lines (+3 instead of +2 for 9 words or fewer) and ignores other text on screen at the same time, which ASCI counts |
| Hold that runs past the end: a **warning** only | A disclaimer cut short ships |
| `overlay_text` size `small` = 64 units on a 1080×1920 PlayRes canvas | On a 16:9 1080p video libass scales it to a font of about 36 px, a lowercase x-height of about 18 px. **Below ASCI's 26 px at 1080.** |
| White text, dark outline, no box | ASCI asks for an opaque single-colour block when text fades, and for contrast |
| No line limit | ASCI allows at most 2 lines |
| Two legal lines can overlap | ASCI allows one disclaimer per frame |
| Plan warning text: the veg mark is "required" | It is an FSSAI packaging rule, not a TV rule (overclaims) |

## 3. Design

### L1: a `legal` style in `overlay_text`, enforced in code
- **New size value `legal`.** Its use is reserved for the disclaimer style.
- **Font size is worked out from the real video height:** font px = ceil(0.046 × H). That gives a lowercase x-height of at least 2.4% of H, which is ≥26 px at 1080, ≥14 px at 576 and ≥57 px at 2160. Implement it as an ASS style scaled to the PlayRes canvas, so the result lands at that px after libass scaling for any aspect ratio. A unit test checks portrait 1080×1920, landscape 1920×1080 and square 1080×1080.
- **Box:** an opaque single-colour block, ASS `BorderStyle=3`, dark (`#000000` at 0 transparency), white text. Contrast is guaranteed by the fixed pair.
- **Font:** the same sans-serif as the other overlays. Italic is off and bold is off.
- **Lines:** wrap to the safe width. If the text needs more than 2 lines at the legal size, `overlay_text` refuses with `LEGAL_TOO_LONG: the disclaimer "<first words…>" needs <n> lines; ASCI allows 2. Shorten it`. Text is never shrunk to fit.
- **Position:** always bottom, inside the safe margin. Face avoidance from Part A still applies (`avoidFaces`): when it moves the line it moves the box with it, and never makes it smaller.
- **Callers that never use `legal` see no change at all;** their filter graphs are pinned by tests.

### L2: hold time by the ASCI formula, counting all text on screen
- `legalHoldSeconds(text, alsoOnScreenWords)` = `words/5 + (words ≤ 9 ? 2 : 3)`, where `words` = the disclaimer's words + all other on-screen words visible during it (shot texts and the packshot tagline).
- **Not counted:** the brand name, a logo, Rs, %. A URL or an email counts as one word.
- **Then:** at least 4 s per line on screen, so a 2-line disclaimer gets at least 8 s.
- **Computed by the plan, never chosen by Director.** The plan stores each legal line's computed `endSeconds`.
- **If the hold does not fit before the end of the ad,** `plan_tvc check` refuses with `LEGAL_HOLD_TOO_LONG: "<text>" needs <x>s on screen; start it earlier, shorten it, or keep it on for the whole ad`. This is a plan error, no longer a warning.
- **Alternative ASCI allows:** `wholeAd: true` keeps the line on screen from 0 to the end. No hold check is needed.

### L3: tied to the claim, synced to the voiceover
- Each legal line gains `forVoiceoverBlock?: number`, the index of the voiceover block that makes the claim.
- **When it is set,** the plan computes the start as that block's `startSeconds`. Director does not choose it.
- **When it is not set,** Director's `startSeconds` stays, for an on-screen-only claim.
- **One per frame:** two legal lines whose `[start, end)` windows overlap get a plan error, `LEGAL_OVERLAP: only one disclaimer on screen at a time`. Exception: lines marked `linkedWith` the same claim (rare; interlinked claims).

### L4: the finish step passes computed values, and the skill text is append-only
- **The finish slice** returns each legal line with `text`, `startSeconds`, `endSeconds` and `style: "legal"`. Director passes these straight to `overlay_text` with `size: "legal"`.
- **`overlay_text`'s 12-overlay cap:** legal lines never count toward the per-shot texts that get dropped first. This keeps the existing rule.
- **Additive lines in `tvc-ad/director.md`:** use the finish slice's legal entries exactly as given (size "legal"); never shorten or move a disclaimer to fit; on `LEGAL_TOO_LONG` or `LEGAL_HOLD_TOO_LONG`, return the reason to Olmo.
- **`tvc-ad.md` (Olmo):** when the user's ad makes a product claim (a number, a comparison, a "clinically", an offer), ask for or confirm its disclaimer in plain words. Tool names are never shown to the user.

### L5: small corrections
- **Veg-mark plan message:** "recommended for food (FSSAI packaging rule; common practice in TV ads)", not "required".
- **"Creative visualisation":** keep auto-adding it; it is industry practice. It uses the legal style. The skill text must not claim it protects a performance claim; ASCI rejected that.

## 4. Error handling
- New plain reasons: `LEGAL_TOO_LONG`, `LEGAL_HOLD_TOO_LONG`, `LEGAL_OVERLAP`.
- Every rule is checked before any paid step. `overlay_text`'s charge and refund are unchanged.

## 5. Testing
- **Unit:** the font px from the frame height (3 aspect ratios); 1-line, 2-line and 3-line text (the 3-line case is refused); the hold formula at 9 and 10 words; concurrent shot text counted; brand, Rs and % not counted; URL = 1 word; the 4 s per line minimum; the voiceover-sync start; overlap refused; `wholeAd`.
- **Legacy pins:** an `overlay_text` call without `legal` builds a byte-identical ASS file and filter graph.
- **Real ffmpeg (tagged):** burn a 2-line legal disclaimer onto a 1920×1080 test clip and measure the box and text height from a frame. The x-height must be at least 26 px.

## 6. Not in this piece
- Animated headline and price text (scope B).
- The logo and veg-mark overlay (scope C).
- Spoken disclaimers (at most 6 syllables per second): later, with the voice pieces.
- Language matching for bilingual ads: later. For now the disclaimer uses the language the user writes it in.
