# TVC Part 2.2: Animated Text, Price, Logo and Veg Mark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TVC headlines, prices and taglines move like a real TV super (a small fixed set of moves, written as ASS tags in code), a price shows as a proper price super, and the packshot carries the brand logo and, for food and drink, the FSSAI veg or non-veg mark. Everything is composited in code, sized from the real frame, and nothing is generated into pixels.

**Architecture:**
- **`textMotion.ts` (new, pure):** the five motion presets as fixed ASS override tags, the rule that picks the motion a line really gets (a disclaimer never moves, under 0.6 s becomes `fade`, no motion asked stays static), and the price super: the money check, `PRICE_*` reasons, font sizes from the shorter side, and the dialogue layout (struck-through MRP, amount, note). `overlay_text` renders with it and `plan_tvc` checks with it, so they never disagree.
- **`overlay_text` (M1, M2):** two optional inputs, `motion` and `price`. A call with neither builds byte-identical ASS and makes the same single ffmpeg call. A price adds the `*-price` styles, needs the real frame (one ffprobe, as the legal style already does), and every price refusal happens before the charge.
- **`packshotMarks.ts` (new, pure):** the logo and veg-mark rules. It sniffs the file kind (PNG, JPEG, WebP, SVG), checks for real transparency in decoded pixels, and does the box maths (9% of the shorter side tall, at most 40% of the width, a 5% margin). It picks the face-free spot, places the veg mark opposite the logo and above the disclaimer box, and builds the filter-graph text for both marks. No user text reaches a filter string: every value is a number or a fixed word.
- **`composite_end_card` (M3, M4):** three optional inputs, `logoFileId`, `vegMark` and `disclaimerLines`. Every logo refusal (`LOGO_IS_PRODUCT_PHOTO`, `LOGO_NOT_RASTER`, `LOGO_NOT_IMAGE`) happens before the charge. The logo and the mark join the same single ffmpeg pass, as a third input and an in-graph `color` source. A call with none of the three is byte-identical, with the same graph, the same arguments and the same two `execFile` calls.
- **The veg mark is drawn inside the end card's own filter graph, not stored as a PNG.** It is a lavfi `color=white` square of exactly 5% of the real frame's shorter side, with the outline and the dot (or the triangle) drawn by one `geq`. Why not a committed asset:
  - The size comes from the real frame, so drawing it at that exact pixel size keeps it crisp at 720p, 1080p and 4K. A stored PNG would be rescaled and go soft.
  - A stored file would need copying into the orchestrator's build output and the VM deploy. Nothing else in the tool reads a repo asset at runtime.
  - Drawing in the graph adds no file read and no extra ffmpeg pass (spec M4: "the same pass as the logo").
- **The plan (`tvcPlan.ts`, `planTvc.ts`, M2, M4, M5):**
  - Shots gain `motion` and `price`. The packshot gains `motion`. The brief gains `logoFileId` and `vegMark`.
  - `plan_tvc check` writes the default motion (`pop` on shot text, `fade` on the tagline) into the saved plan. A plan saved before this change, never re-checked, still slices with no motion (X12).
  - Prices are checked (`PRICE_INVALID`, `PRICE_MRP_NOT_HIGHER`, `PRICE_TOO_SHORT`). The logo is checked the way the product photo is (`LOGO_IS_PRODUCT_PHOTO`, `LOGO_NOT_RASTER`, `LOGO_NOT_IMAGE`, `LOGO_UNCHECKED`).
  - The finish slice passes each shot's `motion` and `price`, plus an `endCard` object (`logoFileId`, `vegMark` for food and drink only, `disclaimerLines`) for `composite_end_card`. `carryOver` ignores `motion` and `price`, so adding the logo or a motion to an old plan never throws away recorded stills and clips (X5).
- **Skill text (M5):** append-only sections in `tvc-ad/director.md` and `tvc-ad.md`.

**Tech Stack:** TypeScript, Mastra `createTool`, zod, vitest, ffmpeg/ffprobe via `execFile` (libass `subtitles` for text; `geq`, `boxblur`, `colorchannelmixer`, `overlay` and `fade` for the marks), fontconfig with Noto Sans (already on the VM since Part 2.1).

**Spec:** `docs/superpowers/specs/2026-10-09-tvc-text-logo-vegmark-design.md` (M1–M5, X1–X12, §5, §6). Read it before your task. The closest precedent is `docs/superpowers/plans/2026-10-07-tvc-legal-disclaimer.md`, whose code is on this branch (`legalText.ts`, the `legal` style in `overlayText.ts`, the E4 guard in `compositeEndCard.ts`).

## Global Constraints

- **Additive prompt changes only:** never delete or reword a shipped line in any skill or agent prompt. Append lines, and edit only `tvc-ad.md` and `tvc-ad/director.md`.
- **Paid tools:** charge first and refund on every failure path, exactly as today. Every new refusal happens **before** the charge:
  - `PRICE_INVALID`, `PRICE_MRP_NOT_HIGHER` and `PRICE_TOO_SHORT` in `overlay_text`.
  - `LOGO_IS_PRODUCT_PHOTO`, `LOGO_NOT_RASTER` and `LOGO_NOT_IMAGE` in `composite_end_card`.

  Do not touch `overlayTextCredits.ts` or `compositeEndCardCredits.ts`.
- **No numeric enums in tool schemas.** Gemini only accepts string enums. `motion` and `vegMark` are string enums. `disclaimerLines` is `z.number().int().min(1).max(2)`, never a literal union.
- **Existing callers unchanged (X10, X12):**
  - **`overlay_text` with no `motion` and no `price`:** the ASS is byte-identical. The pinned three-overlay sha256 stays `57b41e1f0f04bf707c8173700d2569d76a2925221f3fdea2a7775de9611b2a5e`. The call makes one `execFile` (ffmpeg, no ffprobe) with the same arguments and uploads with the title `Video with Text Overlay`.
  - **`overlay_text` with a legal overlay and no new input:** the ASS is byte-identical. For the pinned `LEGAL_PIN` in Task 2 the sha256 is `501904cebc7a1779fdbf6c8cff242a7b33904b1fbe445b5cd3505c9f99f47f0b` at 1920×1080 and `6af377cb85b2337257710005a1a2575472e5fc62ca2ff8e04a89a68eca717ada` at 1080×1920.
  - **`composite_end_card` with no `logoFileId`, `vegMark` or `disclaimerLines`:** `endCardGraph` returns the pinned strings in Task 4. The call makes exactly two `execFile` calls (ffprobe, then ffmpeg) with today's argument list.
  - **A plan saved before this change:** it slices to the same keys (`['brief', 'shots', 'voiceover', 'packshot', 'legal', 'narrationFileIds', 'songFileId']`) with no `motion`, `price` or `endCard`, and prices the same.
- **Sizes come from the real frame (X9).** The logo box, margin, plate, shadow, veg mark and price sizes are all shares of the probed frame's **shorter** side. The logo's maximum width is 40% of the real width. Slide offsets are 4% of the frame height, through the ASS PlayRes canvas, which libass maps onto the real height.
- **No user text in a tag or a filter (X11):** shot text, price strings and notes go through `escapeAssText` and sit only outside `{…}` blocks. Filter strings contain only numbers, fixed words and file paths passed as separate `-i` arguments.
- **Numbers (copied from the spec):**
  - `pop`: scale 80% → 100% over 180 ms, 120 ms fade in.
  - `slide_up`: 4% of the frame height below → in place over 220 ms, 120 ms fade in.
  - `fade`: `\fad(150,150)`.
  - `stamp`: 130% → 115% → 100% over 140 ms, plus a white outline flash for the first 40 ms.
  - Every preset fades out over the last 120 ms or more.
  - Under 0.6 s on screen, a requested move becomes `fade`.
  - A price stays on screen at least 1.2 s.
  - Logo: height ≤ 9% of S, width ≤ 40% of W, margin ≥ 5% of S. A non-transparent logo sits on a rounded white plate with 8% padding.
  - Veg mark: 5% of S. Veg is `#008000` with a dot. Non-veg is `#8B4513` with a triangle. Both have a white square behind them.
- **Plain reasons, verbatim:**
  - `LOGO_NOT_RASTER: upload the logo as PNG or JPG`
  - `LOGO_IS_PRODUCT_PHOTO: the logo is the product photo; ask the user for the brand's logo file (PNG or JPG)`
  - `LOGO_NOT_IMAGE: the logo must be an image file (PNG or JPG); ask the user to upload one`
  - `LOGO_UNCHECKED: could not read the logo; try again` (plan only)
  - `PRICE_INVALID: …`, `PRICE_MRP_NOT_HIGHER: …`, `PRICE_TOO_SHORT: …` as written in Task 1.
- **Real tagged tests:** `RUN_REAL_FFMPEG=1` only. Without it the suite is skipped.
  - The `overlay_text` motion test needs libass and Noto. Without them it skips and says how to install them. The local Mac has no libass, so it runs on the VM.
  - The `composite_end_card` marks test needs no libass. It skips only if ffmpeg or one of its filters is missing, so it also runs on a Mac.
- **Commits:** every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Add `docs/**/*.md` and the skill `.md` files with `git add -f` (the repo ignores `*.md`).
- **Where work happens:** the worktree `.claude/worktrees/text-overlay-bc`, branch `text-overlay-animated`. Never `git stash`, never push. Before the first test run: `pnpm install && pnpm --filter "agent-orchestrator^..." build`.

## Review Focus

1. **Nothing changes for a caller that sends none of the new inputs.**
   - This covers UGC, talking-head and animated ads, and a TVC disclaimer-only call.
   - A stray ffprobe, a re-ordered style list, a `{}` prefix on every Dialogue line, or a renamed `[outv]` label would silently change every one of those ads.
   - Pinned in Task 2 ("Part 2.2 leaves today's output alone") and Task 4 ("legacy end cards are byte-identical").
2. **An old saved plan must not start moving, and re-checking it must not cost the user their clips.**
   - A plan saved before this change has no `motion`. Its finish slice must stay static.
   - When Olmo adds the logo to that plan (X5), `check` writes `pop` into shot text. `carryOver` must not treat that as a changed shot and drop the recorded still and clip.
   - Pinned in Task 5 ("an old saved plan slices exactly as before" and "a logo added to an old saved plan keeps its recorded stills and clips").
3. **User text never reaches an ASS override block.**
   - A headline or price note containing `{\pos(0,0)}` or `\N` must render as plain characters.
   - The motion tags must stay the only `{…}` the line starts with.
   - Pinned in Task 1 ("user text never reaches a tag") and Task 2 ("writes the preset tags before the escaped text").
4. **The logo never lands on a face, and the veg mark never sits under the disclaimer box.**
   - With a face in the top centre, the logo moves to a clear top corner.
   - With a disclaimer over the packshot, the mark sits above its box at 16:9 and at 9:16.
   - Pinned in Task 3 ("moves to a clear top corner…", "…above the disclaimer box…") and Task 4 ("avoids a face in the top band"). Measured on real frames in Task 6.
5. **Every logo problem is refused before money moves, and an opaque RGBA logo still gets its plate.**
   - An SVG, a GIF, an unreadable file and the product photo's own id must each refuse with `spendCredits` never called.
   - A PNG with an alpha channel that is fully opaque (a white box baked in) must get the white plate, because transparency is read from decoded pixels, not the PNG colour type.
   - Pinned in Task 3 ("a decoded RGBA image is transparent only if…") and Task 4 (the refusal tests, and "a fully opaque RGBA logo gets the plate").

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/agent-orchestrator/src/mastra/tools/textMotion.ts` (create) | Pure: `MOTIONS`, `effectiveMotion`, `motionTags`, `priceSchema`, `moneyValue`, `priceError`, `priceTooShortReason`, `priceFontSizes`, `priceDialogue`, constants |
| `apps/agent-orchestrator/src/mastra/tools/textMotion.test.ts` (create) | Unit tests for the above |
| `apps/agent-orchestrator/src/mastra/tools/overlayText.ts` (modify) | M1/M2: `motion` and `price` inputs, `priceStyles`, price checks before the charge, the frame probe for a price |
| `apps/agent-orchestrator/src/mastra/tools/overlayText.test.ts` (modify) | Legacy and legal pins, plus motion and price tests |
| `apps/agent-orchestrator/src/mastra/tools/packshotMarks.ts` (create) | Pure: `sniffImage`, `isSvgFile`, `anyTransparent`, `logoLayout`, `containSize`, `logoRect`, `chooseLogoSpot`, `vegSize`, `legalBandTop`, `vegRect`, `vegCorner`, `vegGeq`, `marksGraph`, the `LOGO_*` reasons |
| `apps/agent-orchestrator/src/mastra/tools/packshotMarks.test.ts` (create) | Unit tests for the above |
| `apps/agent-orchestrator/src/mastra/tools/compositeEndCard.ts` (modify) | M3/M4: `logoFileId`, `vegMark` and `disclaimerLines`; `inspectLogo`; the refusals before the charge; `endCardGraph(..., marks?)`; the third input |
| `apps/agent-orchestrator/src/mastra/tools/compositeEndCard.test.ts` (modify) | Legacy pins, refusal tests and placement tests |
| `apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts` (modify) | Schema fields, default motion at check, price checks, the MRP reminder, the veg warning, `endCardInputs`, the finish slice |
| `apps/agent-orchestrator/src/mastra/tools/tvcPlan.test.ts` (modify) | Plan rule tests |
| `apps/agent-orchestrator/src/mastra/tools/planTvc.ts` (modify) | Logo checks, `carryOver` ignores motion and price, the tool description |
| `apps/agent-orchestrator/src/mastra/tools/planTvc.test.ts` (modify) | Logo refusals, X5 carry-over |
| `apps/agent-orchestrator/src/mastra/tools/compositeEndCard.realffmpeg.test.ts` (create) | Tagged: logo height and veg-mark corner at 16:9 and 9:16 |
| `apps/agent-orchestrator/src/mastra/tools/overlayText.realffmpeg.test.ts` (modify) | Tagged: a `pop` headline and a `stamp` price are still moving early and settled later |
| `products/agent-platform/packages/api/seeds/official-skills/tvc-ad/director.md`, `tvc-ad.md` (modify, append only) | M5 |
| `products/agent-platform/packages/api/__tests__/officialSkillsSeed.test.ts` (modify) | Pins the appended lines |

---

### Task 1: motion presets and the price super as pure code (`textMotion.ts`)

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/textMotion.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/textMotion.test.ts`

**Interfaces:**
- Consumes (from `./legalText.js`, unchanged): `Frame`, `escapeAssText`, `legalTextWidthEm`, `LEGAL_FONT_HEIGHT_PER_EM` (1.362), `LEGAL_PLAY_RES_Y` (1920), `LEGAL_SAFE_WIDTH_SHARE` (0.86).
- Produces (Tasks 2 and 5 import these exact names):
  - `MOTIONS = ['none', 'pop', 'slide_up', 'fade', 'stamp'] as const`, `type Motion`, `type TextPosition = 'top' | 'center' | 'bottom'`
  - `MIN_MOTION_SECONDS = 0.6`, `PRICE_MIN_SECONDS = 1.2`, `FADE_OUT_MS = 120`, `SLIDE_UP_OFFSET = 77`
  - `effectiveMotion(o: { motion?: Motion; size?: string; price?: unknown; startSeconds: number; endSeconds: number }): Motion`
  - `motionTags(motion: Motion, position: TextPosition): string` (`''` for `none`, otherwise one `{…}` block)
  - `priceSchema` (zod: `{ amount: string ≤20; mrp?: string ≤20; note?: string ≤40 }`), `type Price`
  - `moneyValue(text: string): number | null`
  - `priceError(price: Price): string | null`
  - `priceTooShortReason(seconds: number, where?: string): string`
  - `priceFontSizes(frame: Frame): { amount: number; mrp: number; note: number }` (ASS PlayRes units)
  - `priceDialogue(price: Price, frame: Frame): { text: string; tooWide: boolean }`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/agent-orchestrator/src/mastra/tools/textMotion.test.ts
import { describe, it, expect } from 'vitest'
import {
  FADE_OUT_MS, MOTIONS, SLIDE_UP_OFFSET, effectiveMotion, moneyValue, motionTags, priceDialogue, priceError,
  priceFontSizes, priceSchema, priceTooShortReason,
} from './textMotion.js'

const LAND = { width: 1920, height: 1080 }
const PORT = { width: 1080, height: 1920 }
const win = (startSeconds: number, endSeconds: number) => ({ startSeconds, endSeconds })

describe('motion presets (M1)', () => {
  it('writes the fixed tags for each preset', () => {
    expect(motionTags('none', 'top')).toBe('')
    expect(motionTags('pop', 'top')).toBe('{\\fad(120,120)\\fscx80\\fscy80\\t(0,180,\\fscx100\\fscy100)}')
    expect(motionTags('fade', 'center')).toBe('{\\fad(150,150)}')
    expect(motionTags('stamp', 'center')).toBe('{\\fad(0,120)\\fscx130\\fscy130\\t(0,100,\\fscx115\\fscy115)\\t(100,140,\\fscx100\\fscy100)\\3c&HFFFFFF&\\t(40,41,\\3c&H000000&)}')
  })
  it('slide_up rises 4% of the frame height into each band\'s anchor', () => {
    expect(SLIDE_UP_OFFSET).toBe(77)
    expect(motionTags('slide_up', 'top')).toBe('{\\fad(120,120)\\move(540,237,540,160,0,220)}')
    expect(motionTags('slide_up', 'center')).toBe('{\\fad(120,120)\\move(540,1037,540,960,0,220)}')
    expect(motionTags('slide_up', 'bottom')).toBe('{\\fad(120,120)\\move(540,1837,540,1760,0,220)}')
  })
  it('every moving preset fades out over the last 120 ms or more', () => {
    expect(FADE_OUT_MS).toBe(120)
    for (const m of MOTIONS.filter((x) => x !== 'none')) expect(motionTags(m, 'top')).toMatch(/\\fad\(\d+,1[2-9]\d\)/)
  })
})

describe('which motion a line gets (M1, X8, X10)', () => {
  it('no motion asked stays static, even on a short window (legacy callers)', () => {
    expect(effectiveMotion(win(0, 2))).toBe('none')
    expect(effectiveMotion(win(0, 0.4))).toBe('none')
  })
  it('a move under 0.6 s becomes fade', () => {
    expect(effectiveMotion({ ...win(0, 0.59), motion: 'pop' })).toBe('fade')
    expect(effectiveMotion({ ...win(0, 0.6), motion: 'pop' })).toBe('pop')
    expect(effectiveMotion({ ...win(1.4, 2.0), motion: 'stamp' })).toBe('stamp')
  })
  it('a disclaimer never moves; a price stamps by default', () => {
    expect(effectiveMotion({ ...win(0, 4), motion: 'pop', size: 'legal' })).toBe('none')
    expect(effectiveMotion({ ...win(0, 2), price: { amount: '₹499' } })).toBe('stamp')
    expect(effectiveMotion({ ...win(0, 2), price: { amount: '₹499' }, motion: 'slide_up' })).toBe('slide_up')
  })
})

describe('price validation (M2, X6)', () => {
  it.each(['₹499', '₹ 499', 'Rs. 499', 'Rs 1,499', 'rs.99', '₹1,49,999.00', '₹499/-', '$4.99', '€10', 'INR 250', '₹४९९'])('%s is money', (t) => {
    expect(moneyValue(t)).not.toBeNull()
  })
  it.each(['499', 'free', '₹', '₹abc', 'Rs. 4 99', '₹499 only', '{\\b1}₹499', '₹-5'])('%s is not', (t) => {
    expect(moneyValue(t)).toBeNull()
  })
  it('reads Devanagari digits, grouping commas and paise', () => {
    expect(moneyValue('₹४९९')).toBe(499)
    expect(moneyValue('₹1,49,999')).toBe(149999)
    expect(moneyValue('Rs. 1,499.50/-')).toBe(1499.5)
  })
  it('refuses a bad amount, a bad MRP, and an MRP that is not higher', () => {
    expect(priceError({ amount: '₹499' })).toBeNull()
    expect(priceError({ amount: '₹499', mrp: '₹699', note: 'Launch offer' })).toBeNull()
    expect(priceError({ amount: 'cheap' })).toMatch(/^PRICE_INVALID: "cheap" is not a price/)
    expect(priceError({ amount: '₹499', mrp: 'was more' })).toMatch(/^PRICE_INVALID: the MRP "was more" is not a price/)
    expect(priceError({ amount: '₹499', mrp: '₹499' })).toMatch(/^PRICE_MRP_NOT_HIGHER: /)
    expect(priceError({ amount: '₹699', mrp: '₹४९९' })).toMatch(/^PRICE_MRP_NOT_HIGHER: /)
  })
  it('PRICE_TOO_SHORT names the time and the 1.2 s floor', () => {
    expect(priceTooShortReason(0.6, 'the price in shot 3')).toBe('PRICE_TOO_SHORT: the price in shot 3 is on screen for 0.6s; a price needs at least 1.2s. Put it on a shot of 1.2s or longer')
    expect(priceTooShortReason(1)).toMatch(/^PRICE_TOO_SHORT: the price is on screen for 1s/)
  })
  it('caps the lengths in the schema', () => {
    expect(priceSchema.safeParse({ amount: '₹499', note: 'Launch offer' }).success).toBe(true)
    expect(priceSchema.safeParse({ amount: '₹499', note: 'x'.repeat(41) }).success).toBe(false)
  })
})

describe('price sizes come from the shorter side (X9)', () => {
  it('the amount is 144 px at S 1080 in both orientations; the MRP 60%, the note 45%', () => {
    expect(priceFontSizes(PORT)).toEqual({ amount: 144, mrp: 86, note: 65 })
    expect(priceFontSizes(LAND)).toEqual({ amount: 256, mrp: 154, note: 115 })
    // ASS sizes are PlayRes units; libass scales them by frame height / 1920.
    expect(Math.round(priceFontSizes(LAND).amount * 1080 / 1920)).toBe(144)
  })
})

describe('price layout (M2, X11)', () => {
  it('the MRP struck through to the left, the note under the amount', () => {
    expect(priceDialogue({ amount: '₹499', mrp: '₹699', note: 'Launch offer' }, PORT)).toEqual({
      text: '{\\fs86\\s1}₹699{\\s0\\fs144}\\h₹499\\N{\\fs65}Launch offer', tooWide: false,
    })
  })
  it('stacks the MRP above the amount when both do not fit one line', () => {
    expect(priceDialogue({ amount: '₹1,49,999', mrp: '₹1,99,999' }, PORT).text).toBe('{\\fs86\\s1}₹1,99,999{\\s0\\fs144}\\N₹1,49,999')
    expect(priceDialogue({ amount: '₹1,49,999', mrp: '₹1,99,999' }, LAND).text).toBe('{\\fs154\\s1}₹1,99,999{\\s0\\fs256}\\h₹1,49,999')
  })
  it('just the amount', () => {
    expect(priceDialogue({ amount: '₹499' }, LAND)).toEqual({ text: '₹499', tooWide: false })
  })
  it('flags an amount too wide for the frame', () => {
    expect(priceDialogue({ amount: `₹${'9'.repeat(14)}` }, PORT).tooWide).toBe(true)
  })
  it('user text never reaches a tag: braces and backslashes are stripped from the note (Review Focus 3)', () => {
    expect(priceDialogue({ amount: '₹499', note: '{\\fs300\\pos(0,0)}Launch \\N offer' }, PORT).text).toBe('₹499\\N{\\fs65}fs300pos(0,0)Launch N offer')
  })
})
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/textMotion.test.ts`
Expected: FAIL with "Failed to resolve import ./textMotion.js".

- [ ] **Step 3: Write the module**

```ts
// apps/agent-orchestrator/src/mastra/tools/textMotion.ts
// TVC Part 2.2 (spec 2026-10-09 M1, M2, X6–X11): how on-screen text moves,
// and the price super. Pure code shared by overlay_text (render) and plan_tvc
// (checks), so the two never disagree. Every ASS override tag here is built
// from fixed text and numbers only; user text goes through escapeAssText and
// only ever sits OUTSIDE a {...} block.
import { z } from 'zod'
import { LEGAL_FONT_HEIGHT_PER_EM, LEGAL_PLAY_RES_Y, LEGAL_SAFE_WIDTH_SHARE, escapeAssText, legalTextWidthEm, type Frame } from './legalText.js'

export const MOTIONS = ['none', 'pop', 'slide_up', 'fade', 'stamp'] as const
export type Motion = typeof MOTIONS[number]
export type TextPosition = 'top' | 'center' | 'bottom'

/** M1: a move needs time to read; under this, any asked move becomes fade. */
export const MIN_MOTION_SECONDS = 0.6
/** X7: a price is a claim; it stays on screen at least this long. */
export const PRICE_MIN_SECONDS = 1.2
/** M1: every preset fades out over the last 120 ms so text never pops off. */
export const FADE_OUT_MS = 120

// overlay_text writes one ASS canvas, PlayRes 1080x1920. libass maps PlayResY
// onto the real frame height, so a share of 1920 is the same share of the
// real frame. The anchors match the styles' alignment and MarginV (160).
const PLAY_RES_X = 1080
const MARGIN_V = 160
const ANCHOR_Y: Record<TextPosition, number> = { top: MARGIN_V, center: LEGAL_PLAY_RES_Y / 2, bottom: LEGAL_PLAY_RES_Y - MARGIN_V }
/** slide_up starts 4% of the frame height below its place (77 of 1920). */
export const SLIDE_UP_OFFSET = Math.round(0.04 * LEGAL_PLAY_RES_Y)

/** The motion a line really gets. No motion asked = today's static text, on
 *  any window (X10, X12). A disclaimer never moves (X8). A price stamps by
 *  default (M2). Under 0.6 s any asked move becomes fade (M1). */
export function effectiveMotion(o: { motion?: Motion; size?: string; price?: unknown; startSeconds: number; endSeconds: number }): Motion {
  if (o.size === 'legal' && !o.price) return 'none'
  const asked: Motion = o.motion ?? (o.price ? 'stamp' : 'none')
  if (asked === 'none') return 'none'
  return o.endSeconds - o.startSeconds < MIN_MOTION_SECONDS - 1e-9 ? 'fade' : asked
}

export function motionTags(motion: Motion, position: TextPosition): string {
  switch (motion) {
    case 'none': return ''
    case 'pop': return `{\\fad(120,${FADE_OUT_MS})\\fscx80\\fscy80\\t(0,180,\\fscx100\\fscy100)}`
    case 'slide_up': {
      const x = PLAY_RES_X / 2, y = ANCHOR_Y[position]
      return `{\\fad(120,${FADE_OUT_MS})\\move(${x},${y + SLIDE_UP_OFFSET},${x},${y},0,220)}`
    }
    case 'fade': return '{\\fad(150,150)}'
    // 130% -> 115% -> 100% in 140 ms, and the outline flashes white for the
    // first 40 ms (about one frame) before going back to the styles' black.
    case 'stamp': return `{\\fad(0,${FADE_OUT_MS})\\fscx130\\fscy130\\t(0,100,\\fscx115\\fscy115)\\t(100,140,\\fscx100\\fscy100)\\3c&HFFFFFF&\\t(40,41,\\3c&H000000&)}`
  }
}

export const priceSchema = z.object({
  amount: z.string().min(1).max(20).describe('The price, e.g. "₹499" or "Rs. 499"'),
  mrp: z.string().min(1).max(20).optional().describe('The higher MRP, shown smaller and struck through, e.g. "₹699"'),
  note: z.string().min(1).max(40).optional().describe('A short line under the price, e.g. "Launch offer"'),
})
export type Price = z.infer<typeof priceSchema>

// X6: Devanagari digits (U+0966–U+096F) are money too; Noto Sans draws them.
const DIGITS = '0-9०-९'
const CURRENCY = '(?:₹|Rs\\.?|INR|[$€£¥])'
const MONEY_RE = new RegExp(`^${CURRENCY}\\s?[${DIGITS}][${DIGITS},]*(?:\\.[${DIGITS}]{1,2})?(?:/-)?$`, 'iu')
const CURRENCY_PREFIX_RE = new RegExp(`^${CURRENCY}\\s?`, 'iu')
const toAsciiDigits = (s: string) => s.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966))

export function moneyValue(text: string): number | null {
  const t = text.trim()
  if (!MONEY_RE.test(t)) return null
  const n = Number(toAsciiDigits(t).replace(CURRENCY_PREFIX_RE, '').replace(/\/-$/, '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/** M2: the amount and the MRP must look like money; an MRP must be higher. */
export function priceError(price: Price): string | null {
  const amount = moneyValue(price.amount)
  if (amount === null) return `PRICE_INVALID: "${price.amount}" is not a price; write it like ₹499 or Rs. 499`
  if (price.mrp !== undefined) {
    const mrp = moneyValue(price.mrp)
    if (mrp === null) return `PRICE_INVALID: the MRP "${price.mrp}" is not a price; write it like ₹699`
    if (!(mrp > amount)) return `PRICE_MRP_NOT_HIGHER: the MRP ${price.mrp} must be higher than the price ${price.amount}; drop the MRP or fix the numbers`
  }
  return null
}

export function priceTooShortReason(seconds: number, where = 'the price'): string {
  return `PRICE_TOO_SHORT: ${where} is on screen for ${Math.round(seconds * 100) / 100}s; a price needs at least ${PRICE_MIN_SECONDS}s. Put it on a shot of ${PRICE_MIN_SECONDS}s or longer`
}

/** X9: font heights as a share of the shorter side. The amount is the 9:16
 *  canvas's large (120) × 1.2 = 144 px at S 1080, in both orientations. */
export const PRICE_AMOUNT_SHARE = 0.1333
export const PRICE_MRP_RATIO = 0.6
export const PRICE_NOTE_RATIO = 0.45
/** Noto Sans Bold runs wider than the Regular widths legalTextWidthEm models. */
const BOLD_WIDTH = 1.08
const toPlayRes = (px: number, frame: Frame) => Math.round(px * LEGAL_PLAY_RES_Y / frame.height)

export function priceFontSizes(frame: Frame): { amount: number; mrp: number; note: number } {
  const amountPx = PRICE_AMOUNT_SHARE * Math.min(frame.width, frame.height)
  return {
    amount: toPlayRes(amountPx, frame),
    mrp: toPlayRes(amountPx * PRICE_MRP_RATIO, frame),
    note: toPlayRes(amountPx * PRICE_NOTE_RATIO, frame),
  }
}

const widthPx = (text: string, size: number, frame: Frame): number =>
  legalTextWidthEm(text) * (size * frame.height / LEGAL_PLAY_RES_Y) / LEGAL_FONT_HEIGHT_PER_EM * BOLD_WIDTH

/** M2: the Dialogue text of a price super. The MRP is smaller and struck
 *  through (\s1), left of the amount, or above it when both do not fit one
 *  line; the note is small, under the amount. tooWide: the amount alone does
 *  not fit the frame's safe width. */
export function priceDialogue(price: Price, frame: Frame): { text: string; tooWide: boolean } {
  const fs = priceFontSizes(frame)
  const max = LEGAL_SAFE_WIDTH_SHARE * frame.width
  const amount = escapeAssText(price.amount)
  const mrp = price.mrp ? escapeAssText(price.mrp) : ''
  const note = price.note ? escapeAssText(price.note) : ''
  const tooWide = widthPx(amount, fs.amount, frame) > max
  let text = amount
  if (mrp) {
    const oneLine = widthPx(mrp, fs.mrp, frame) + widthPx(' ', fs.amount, frame) + widthPx(amount, fs.amount, frame) <= max
    text = `{\\fs${fs.mrp}\\s1}${mrp}{\\s0\\fs${fs.amount}}${oneLine ? '\\h' : '\\N'}${amount}`
  }
  if (note) text += `\\N{\\fs${fs.note}}${note}`
  return { text, tooWide }
}
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/textMotion.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/textMotion.ts apps/agent-orchestrator/src/mastra/tools/textMotion.test.ts
git commit -m "feat(tvc-text): motion presets and the price super as pure code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `overlay_text` gains `motion` and `price` (M1, M2, X7, X8, X10, X11)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/overlayText.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/overlayText.test.ts`

**Interfaces:**
- Consumes (Task 1): `MOTIONS`, `Motion`, `Price`, `priceSchema`, `PRICE_MIN_SECONDS`, `effectiveMotion`, `motionTags`, `priceDialogue`, `priceError`, `priceFontSizes`, `priceTooShortReason`.
- Produces:
  - `TextOverlay` gains `motion?: Motion` and `price?: Price`.
  - `priceStyles(frame: Frame): string[]` (three `*-price` styles, in the same bottom/center/top order as `legalStyles`).
  - `buildAss(overlays, frame?)` throws `Error('PRICE_NEEDS_FRAME')` when a price comes without a frame.
  - Input schema: each overlay gains `motion: z.enum(MOTIONS).optional()` and `price: priceSchema.optional()`.
  - Refusal reasons `PRICE_INVALID: …`, `PRICE_MRP_NOT_HIGHER: …` and `PRICE_TOO_SHORT: …`, all uncharged.

- [ ] **Step 1: Pin today's behaviour first** (these pass before any change; they guard Review Focus 1)

Append to `overlayText.test.ts`. It reuses `LEGACY`, `LEGACY_SHA`, `sha`, `okOverlay`, `baseCtx`, `probeAnd` and the mocks already in the file.

```ts
const LEGAL_PIN = [
  { text: 'Soft all day', startSeconds: 12, endSeconds: 15, position: 'center' as const, size: 'large' as const },
  { text: 'Based on a lab test. Results may vary.', startSeconds: 3, endSeconds: 9, position: 'bottom' as const, size: 'legal' as const },
]
const LEGAL_PIN_SHA_16_9 = '501904cebc7a1779fdbf6c8cff242a7b33904b1fbe445b5cd3505c9f99f47f0b'
const LEGAL_PIN_SHA_9_16 = '6af377cb85b2337257710005a1a2575472e5fc62ca2ff8e04a89a68eca717ada'

describe('Part 2.2 leaves today\'s output alone (X10, X12, Review Focus 1)', () => {
  it('legacy and legal ASS are byte-identical', () => {
    expect(sha(buildAss(LEGACY))).toBe(LEGACY_SHA)
    expect(sha(buildAss(LEGAL_PIN, { width: 1920, height: 1080 }))).toBe(LEGAL_PIN_SHA_16_9)
    expect(sha(buildAss(LEGAL_PIN, { width: 1080, height: 1920 }))).toBe(LEGAL_PIN_SHA_9_16)
  })
})
```

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/overlayText.test.ts`
Expected: PASS. If it fails before any change, stop and report it: the pin is wrong, not the code.

- [ ] **Step 2: Write the failing tests** (append)

Add `priceStyles` to the existing import from `./overlayText.js`.

```ts
describe('motion and price never disturb old calls (Review Focus 1)', () => {
  it('motion "none" is the same as no motion', () => {
    expect(sha(buildAss(LEGACY.map((o) => ({ ...o, motion: 'none' as const }))))).toBe(LEGACY_SHA)
  })
  it('a disclaimer asked to move stays static (X8)', () => {
    const moved = LEGAL_PIN.map((o) => (o.size === 'legal' ? { ...o, motion: 'pop' as const } : o))
    expect(sha(buildAss(moved, { width: 1920, height: 1080 }))).toBe(LEGAL_PIN_SHA_16_9)
  })
})

describe('motion (M1)', () => {
  it('writes the preset tags before the escaped text (Review Focus 3)', () => {
    const ass = buildAss([{ ...okOverlay, text: 'Stop {\\pos(0,0)}scrolling', motion: 'pop' }])
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:02.00,top-medium,,0,0,0,,{\\fad(120,120)\\fscx80\\fscy80\\t(0,180,\\fscx100\\fscy100)}Stop pos(0,0)scrolling')
    expect(ass).not.toContain('-price,')
  })
  it('a short window turns an asked move into fade', () => {
    expect(buildAss([{ ...okOverlay, endSeconds: 0.5, motion: 'slide_up' }])).toContain(',,{\\fad(150,150)}Stop scrolling')
  })
  it('a motion-only call never probes the frame: one ffmpeg call, the plain upload', async () => {
    execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (err: Error | null) => void) => cb(null))
    vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from('mp4'))
    uploadGeneratedFile.mockResolvedValueOnce({ fileId: 'out1', name: 'o.mp4', type: 'video/mp4', size: 3 })
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [{ ...okOverlay, motion: 'slide_up' }] } as never, baseCtx())
    expect(result).toMatchObject({ fileId: 'out1' })
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(execFile.mock.calls[0][0]).toBe('ffmpeg')
    const assWrite = vi.mocked(fs.writeFileSync).mock.calls.find((c) => String(c[0]).endsWith('overlay.ass'))!
    expect(String(assWrite[1])).toContain(',,{\\fad(120,120)\\move(540,237,540,160,0,220)}Stop scrolling')
    expect(uploadFileWithKey).not.toHaveBeenCalled()
  })
  it('the schema takes the five presets as strings and refuses anything else', () => {
    expect(inputSchema.safeParse({ videoFileId: 'v1', overlays: [{ ...okOverlay, motion: 'stamp' }] }).success).toBe(true)
    expect(inputSchema.safeParse({ videoFileId: 'v1', overlays: [{ ...okOverlay, motion: 'spin' }] }).success).toBe(false)
  })
})

describe('the price super (M2)', () => {
  const price = { amount: '₹499', mrp: '₹699', note: 'Launch offer' }
  it('adds the price styles only for a price, and lays it out from the real frame with a stamp', () => {
    const ass = buildAss([{ ...okOverlay, position: 'center', text: 'ignored', price }], { width: 1080, height: 1920 })
    expect(ass).toContain('Style: center-price,Noto Sans,144,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,4,1,5,60,60,0,1')
    expect(ass).toContain(',center-price,,0,0,0,,{\\fad(0,120)\\fscx130\\fscy130\\t(0,100,\\fscx115\\fscy115)\\t(100,140,\\fscx100\\fscy100)\\3c&HFFFFFF&\\t(40,41,\\3c&H000000&)}{\\fs86\\s1}₹699{\\s0\\fs144}\\h₹499\\N{\\fs65}Launch offer')
    expect(ass).not.toContain('ignored')
    expect(priceStyles({ width: 1920, height: 1080 })[0]).toBe('Style: bottom-price,Noto Sans,256,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,4,1,2,60,60,160,1')
    expect(buildAss([okOverlay])).not.toContain('-price,')
    expect(() => buildAss([{ ...okOverlay, price }])).toThrow('PRICE_NEEDS_FRAME')
  })
  it.each([
    [{ amount: 'cheap' }, 2, /^PRICE_INVALID: /],
    [{ amount: '₹499', mrp: '₹399' }, 2, /^PRICE_MRP_NOT_HIGHER: /],
    [{ amount: '₹499' }, 1, /^PRICE_TOO_SHORT: /],
  ])('refuses %o before any download, probe or charge', async (p, end, reason) => {
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [{ ...okOverlay, endSeconds: end, price: p }] } as never, baseCtx())
    expect(result).toMatchObject({ refused: true, refusalReason: expect.stringMatching(reason) })
    expect(downloadToSessionCache).not.toHaveBeenCalled()
    expect(execFile).not.toHaveBeenCalled()
    expect(spendCredits).not.toHaveBeenCalled()
  })
  it('probes the frame for a price and refuses one too wide for it, uncharged', async () => {
    probeAnd(1080, 1920)
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [{ ...okOverlay, price: { amount: `₹${'9'.repeat(14)}` } }] } as never, baseCtx())
    expect(result).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^PRICE_INVALID: .*too wide/) })
    expect(spendCredits).not.toHaveBeenCalled()
    expect(execFile.mock.calls.map((c) => c[0])).toEqual(['ffprobe'])
  })
  it('burns a price: one probe, one ffmpeg call, one charge, the plain upload', async () => {
    probeAnd(1920, 1080)
    vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from('mp4'))
    uploadGeneratedFile.mockResolvedValueOnce({ fileId: 'out1', name: 'o.mp4', type: 'video/mp4', size: 3 })
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [{ ...okOverlay, position: 'center', price }] } as never, baseCtx())
    expect(result).toMatchObject({ fileId: 'out1' })
    expect(execFile.mock.calls.map((c) => c[0])).toEqual(['ffprobe', 'ffmpeg'])
    expect(spendCredits).toHaveBeenCalledTimes(1)
    const assWrite = vi.mocked(fs.writeFileSync).mock.calls.find((c) => String(c[0]).endsWith('overlay.ass'))!
    expect(String(assWrite[1])).toContain('{\\fs154\\s1}₹699{\\s0\\fs256}\\h₹499\\N{\\fs115}Launch offer')
    expect(uploadGeneratedFile).toHaveBeenCalledWith('tok', expect.objectContaining({ title: 'Video with Text Overlay' }))
  })
})
```

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/overlayText.test.ts`
Expected: FAIL. `priceStyles` is not exported, and motion is not written.

- [ ] **Step 3: Implement**

In `overlayText.ts`:

1. Add the import:

```ts
import { MOTIONS, PRICE_MIN_SECONDS, effectiveMotion, motionTags, priceDialogue, priceError, priceFontSizes, priceSchema, priceTooShortReason, type Motion, type Price } from './textMotion.js'
```

2. Extend `TextOverlay`:

```ts
export interface TextOverlay {
  text: string
  startSeconds: number
  endSeconds: number
  position: keyof typeof ALIGNMENTS
  size?: OverlaySize
  motion?: Motion
  price?: Price
}
```

3. Add `priceStyles` after `legalStyles`:

```ts
/** M2: the price super. Noto Sans (it has Devanagari digits, X6), bold, white
 *  with the same outline and shadow as the other styles, sized from the real
 *  frame's shorter side. Only added when a call has a price. */
export function priceStyles(frame: Frame): string[] {
  const { amount } = priceFontSizes(frame)
  return (Object.keys(ALIGNMENTS) as (keyof typeof ALIGNMENTS)[]).map((pos) =>
    `Style: ${pos}-price,${LEGAL_FONT},${amount},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,4,1,${ALIGNMENTS[pos]},60,60,${pos === 'center' ? 0 : 160},1`)
}
```

4. Replace `dialogueText` and `buildAss`:

```ts
const dialogueText = (o: TextOverlay, frame?: Frame): string => {
  if (o.price && frame) return priceDialogue(o.price, frame).text
  return o.size === 'legal' && frame ? wrapLegal(escapeAssText(o.text), frame).join('\\N') : escapeAssText(o.text)
}
const styleFor = (o: TextOverlay): string => (o.price ? `${o.position}-price` : `${o.position}-${o.size ?? 'medium'}`)

export function buildAss(overlays: TextOverlay[], frame?: Frame): string {
  const hasLegal = overlays.some((o) => o.size === 'legal')
  const hasPrice = overlays.some((o) => o.price)
  if (hasLegal && !frame) throw new Error('LEGAL_NEEDS_FRAME')
  if (hasPrice && !frame) throw new Error('PRICE_NEEDS_FRAME')
  const styles = (Object.keys(ALIGNMENTS) as (keyof typeof ALIGNMENTS)[])
    .flatMap((pos) => (Object.keys(FONT_SIZES) as (keyof typeof FONT_SIZES)[]).map((size) =>
      `Style: ${pos}-${size},DejaVu Sans,${FONT_SIZES[size]},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,4,1,${ALIGNMENTS[pos]},60,60,${pos === 'center' ? 0 : 160},1`))
  if (hasLegal) styles.push(...legalStyles(frame!))
  if (hasPrice) styles.push(...priceStyles(frame!))
  // M1: the motion tags (none = '') go first, then the escaped text.
  const events = overlays.map((o) =>
    `Dialogue: 0,${formatAssTimestamp(o.startSeconds)},${formatAssTimestamp(o.endSeconds)},${styleFor(o)},,0,0,0,,${motionTags(effectiveMotion(o), o.position)}${dialogueText(o, frame)}`)
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...events,
    '',
  ].join('\n')
}
```

5. In `inputSchema`, add these to the overlay object after `size`:

```ts
    motion: z.enum(MOTIONS).optional().describe('How the text comes in: none (the default, static), pop, slide_up, fade, or stamp (for prices). A disclaimer never moves; under 0.6s on screen any move becomes fade'),
    price: priceSchema.optional().describe('A price super: the amount large, an optional struck-through MRP and a short note under it; text is ignored, size is ignored, and it stamps in unless motion says otherwise. At least 1.2s on screen'),
```

6. In `execute`, right after the `INVALID_OVERLAY` check:

```ts
    // M2/X7: a price is checked before anything is downloaded or charged.
    for (const o of overlays) {
      if (!o.price) continue
      const err = priceError(o.price)
      if (err) return { refused: true, refusalReason: err, jobId }
      const seconds = o.endSeconds - o.startSeconds
      if (seconds < PRICE_MIN_SECONDS - 1e-9) return { refused: true, refusalReason: priceTooShortReason(seconds), jobId }
    }
    const hasPrice = overlays.some((o) => o.price)
```

7. Change the frame block's condition from `if (hasLegal) {` to `if (hasLegal || hasPrice) {`. Keep the legal loop as it is. After it, inside the same block, add:

```ts
      for (const o of requested) {
        if (o.price && priceDialogue(o.price, frame).tooWide) {
          return { refused: true, refusalReason: `PRICE_INVALID: "${o.price.amount}" is too wide to show on one line; write it shorter`, jobId }
        }
      }
```

The upload stays keyed on `hasLegal` only. A price alone uses `uploadGeneratedFile`, exactly as today.

8. Append to the tool `description`: `' Text can move: motion pop, slide_up, fade or stamp (default none, static); a disclaimer never moves. price shows a price super (the amount large, an optional struck-through MRP and a note) that stamps in; a bad price is refused with PRICE_INVALID, PRICE_MRP_NOT_HIGHER or PRICE_TOO_SHORT, uncharged.'`

- [ ] **Step 4: Run the tests and check that they pass**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/overlayText.test.ts src/mastra/tools/textMotion.test.ts && pnpm --filter agent-orchestrator type-check`
Expected: PASS. The existing "legacy calls are byte-identical" tests and every legal test pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/overlayText.ts apps/agent-orchestrator/src/mastra/tools/overlayText.test.ts
git commit -m "feat(overlay-text): motion presets and a price super, old calls byte-identical

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: the logo and veg-mark rules as pure code (`packshotMarks.ts`)

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/packshotMarks.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/packshotMarks.test.ts`

**Interfaces:**
- Consumes: `Frame`, `legalAssFontSize`, `LEGAL_BOX_PADDING`, `LEGAL_PLAY_RES_Y` from `./legalText.js`. The type `Box` (`{ x0, y0, x1, y1 }` as fractions) from `./tvcChecks.js`, as a **type-only** import (the end-card tests mock `tvcChecks.js` with only four functions).
- Produces (Tasks 4 and 5 import these exact names):
  - Reasons: `LOGO_IS_PRODUCT_PHOTO`, `LOGO_NOT_RASTER`, `LOGO_NOT_IMAGE`, `LOGO_UNCHECKED` (strings, verbatim from Global Constraints)
  - `type ImageKind = 'png' | 'jpeg' | 'webp' | 'svg' | 'other'`, `sniffImage(buf: Buffer): ImageKind`, `isSvgFile(mimeType: string, pathname: string): boolean`
  - `anyTransparent(rgba: Buffer): boolean` (some alpha byte < 250)
  - `interface LogoLayout { boxW; boxH; pad; radius; margin; shadow }`, `logoLayout(frame: Frame, plated: boolean): LogoLayout`
  - `containSize(srcW, srcH, maxW, maxH): { w: number; h: number }`
  - `type LogoSpot = 'top-center' | 'top-right' | 'top-left'`, `interface Rect { x; y; w; h }` (pixels)
  - `logoRect(spot, frame, size: { w; h }, margin): Rect`, `chooseLogoSpot(faces: Box[], frame, size, margin): LogoSpot`
  - `type Corner = 'bottom-right' | 'bottom-left'`, `vegSize(frame): number`, `legalBandTop(frame, lines: number): number`, `vegRect(corner, frame, disclaimerLines?): Rect`, `vegCorner(logoSpot: LogoSpot | undefined, faces: Box[], frame, disclaimerLines?): Corner`
  - `vegGeq(kind: 'veg' | 'non_veg', n: number): string`
  - `interface Marks { logo?: { size: { w; h }; rect: Rect; plated: boolean; layout: LogoLayout }; veg?: { kind: 'veg' | 'non_veg'; rect: Rect }; dissolveStart: number; totalSeconds: number; logoInput: string }`, `marksGraph(m: Marks, from?: string): string` (reads `[carded]`, ends on `[outv]`)

- [ ] **Step 1: Write the failing tests**

```ts
// apps/agent-orchestrator/src/mastra/tools/packshotMarks.test.ts
import { describe, it, expect } from 'vitest'
import {
  anyTransparent, chooseLogoSpot, containSize, isSvgFile, legalBandTop, logoLayout, logoRect, marksGraph, sniffImage,
  vegCorner, vegGeq, vegRect, vegSize,
} from './packshotMarks.js'

const LAND = { width: 1920, height: 1080 }
const PORT = { width: 1080, height: 1920 }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

describe('what kind of file the logo is (X3)', () => {
  it.each([
    [PNG, 'png'],
    [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'jpeg'],
    [Buffer.from('RIFF\0\0\0\0WEBPVP8 '), 'webp'],
    [Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'svg'],
    [Buffer.from('﻿  <svg viewBox="0 0 1 1"/>'), 'svg'],
    [Buffer.from('GIF89a'), 'other'],
    [Buffer.from(''), 'other'],
    [Buffer.from('<html><body>svg</body></html>'), 'other'],
  ])('%#: %s', (buf, kind) => {
    expect(sniffImage(buf as Buffer)).toBe(kind)
  })
  it('an SVG by type or by name', () => {
    expect(isSvgFile('image/svg+xml', '/x/logo')).toBe(true)
    expect(isSvgFile('application/octet-stream', '/x/logo.SVG')).toBe(true)
    expect(isSvgFile('image/png', '/x/logo.png')).toBe(false)
  })
})

describe('transparency is read from pixels, not the PNG type (X2, Review Focus 5)', () => {
  it('a decoded RGBA image is transparent only if some pixel is see-through', () => {
    expect(anyTransparent(Buffer.from([255, 0, 0, 255, 0, 0, 0, 255]))).toBe(false)
    expect(anyTransparent(Buffer.from([255, 0, 0, 255, 0, 0, 0, 0]))).toBe(true)
    expect(anyTransparent(Buffer.from([255, 0, 0, 249]))).toBe(true)
  })
})

describe('the logo box (M3, X1, X9)', () => {
  it('9% of the shorter side tall, at most 40% of the width, a 5% margin; a plate pads 8%', () => {
    expect(logoLayout(LAND, false)).toEqual({ boxW: 768, boxH: 97, pad: 0, radius: 0, margin: 54, shadow: 4 })
    expect(logoLayout(PORT, true)).toEqual({ boxW: 432, boxH: 97, pad: 8, radius: 17, margin: 54, shadow: 0 })
    expect(logoLayout({ width: 1280, height: 720 }, true)).toEqual({ boxW: 512, boxH: 65, pad: 5, radius: 12, margin: 36, shadow: 0 })
  })
  it.each([
    ['a 20:1 wordmark at 9:16', 2000, 100, 432, 97, { w: 432, h: 22 }],
    ['a 1:4 tall logo at 16:9', 200, 800, 768, 97, { w: 24, h: 97 }],
    ['a square logo at 16:9', 500, 500, 768, 97, { w: 97, h: 97 }],
    ['a 4:1 logo at 16:9', 800, 200, 768, 97, { w: 388, h: 97 }],
    ['a 4:1 logo inside a plate at 9:16', 800, 200, 416, 81, { w: 324, h: 81 }],
  ])('contains %s, keeping its aspect ratio', (_name, sw, sh, bw, bh, size) => {
    expect(containSize(sw, sh, bw, bh)).toEqual(size)
  })
})

describe('where the logo goes (M3, Review Focus 4)', () => {
  const size = { w: 340, h: 97 }
  it('top centre by default, inside the margin', () => {
    expect(logoRect('top-center', LAND, size, 54)).toEqual({ x: 790, y: 54, w: 340, h: 97 })
    expect(logoRect('top-right', LAND, size, 54)).toEqual({ x: 1526, y: 54, w: 340, h: 97 })
    expect(logoRect('top-left', LAND, size, 54)).toEqual({ x: 54, y: 54, w: 340, h: 97 })
    expect(chooseLogoSpot([], LAND, size, 54)).toBe('top-center')
  })
  it('moves to a clear top corner when a face is in the top band, never over the face', () => {
    expect(chooseLogoSpot([{ x0: 0.4, y0: 0.02, x1: 0.6, y1: 0.3 }], LAND, size, 54)).toBe('top-right')
    expect(chooseLogoSpot([{ x0: 0.4, y0: 0.02, x1: 0.95, y1: 0.3 }], LAND, size, 54)).toBe('top-left')
  })
  it('a face lower in the frame does not move it', () => {
    expect(chooseLogoSpot([{ x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.8 }], LAND, size, 54)).toBe('top-center')
  })
  it('with no clear spot, takes the one that overlaps faces least', () => {
    expect(chooseLogoSpot([{ x0: 0, y0: 0, x1: 0.7, y1: 0.3 }, { x0: 0.85, y0: 0.05, x1: 0.9, y1: 0.1 }], LAND, size, 54)).toBe('top-right')
  })
})

describe('the veg mark (M4, X9)', () => {
  it('is 5% of the shorter side', () => {
    expect(vegSize(LAND)).toBe(54)
    expect(vegSize(PORT)).toBe(54)
    expect(vegSize({ width: 1280, height: 720 })).toBe(36)
  })
  it('goes in the bottom corner opposite the logo', () => {
    expect(vegCorner('top-center', [], LAND)).toBe('bottom-right')
    expect(vegCorner('top-left', [], LAND)).toBe('bottom-right')
    expect(vegCorner('top-right', [], LAND)).toBe('bottom-left')
    expect(vegCorner(undefined, [], LAND)).toBe('bottom-right')
  })
  it('switches bottom corners only to get off a face', () => {
    expect(vegCorner('top-center', [{ x0: 0.8, y0: 0.6, x1: 1, y1: 1 }], LAND)).toBe('bottom-left')
    expect(vegCorner('top-center', [{ x0: 0, y0: 0.6, x1: 1, y1: 1 }], LAND)).toBe('bottom-right')
  })
  it('sits inside the margin, or above the disclaimer box when one is over the packshot (Review Focus 4)', () => {
    expect(vegRect('bottom-right', LAND)).toEqual({ x: 1812, y: 972, w: 54, h: 54 })
    expect(vegRect('bottom-left', PORT)).toEqual({ x: 54, y: 1812, w: 54, h: 54 })
    expect(legalBandTop(LAND, 1)).toBe(901)
    expect(legalBandTop(LAND, 2)).toBe(825)
    expect(legalBandTop(PORT, 1)).toBe(1661)
    expect(legalBandTop(PORT, 2)).toBe(1586)
    expect(vegRect('bottom-right', LAND, 2)).toEqual({ x: 1812, y: 749, w: 54, h: 54 })
    expect(vegRect('bottom-right', PORT, 1)).toEqual({ x: 972, y: 1585, w: 54, h: 54 })
  })
  it('draws the FSSAI shapes in their colours, from numbers only', () => {
    const border = 'between(X,5,48)*between(Y,5,48)*(1-between(X,9,44)*between(Y,9,44))'
    const veg = `gt(${border}+lte(hypot(X-26.5,Y-26.5),11),0)`
    expect(vegGeq('veg', 54)).toBe(`geq=r='if(${veg},0,255)':g='if(${veg},128,255)':b='if(${veg},0,255)'`)
    const nonVeg = `gt(${border}+between(Y,16,38)*lte(abs(X-26.5)*22,(Y-16)*12),0)`
    expect(vegGeq('non_veg', 54)).toBe(`geq=r='if(${nonVeg},139,255)':g='if(${nonVeg},69,255)':b='if(${nonVeg},19,255)'`)
  })
})

describe('the marks graph: the same pass as the card, no user text', () => {
  const base = { dissolveStart: 8.5, totalSeconds: 10, logoInput: '[2:v]' }
  it('a plated logo, then the veg mark, ending on [outv]', () => {
    const g = marksGraph({
      ...base,
      logo: { size: { w: 324, h: 81 }, rect: { x: 790, y: 54, w: 340, h: 97 }, plated: true, layout: logoLayout(LAND, true) },
      veg: { kind: 'veg', rect: { x: 1812, y: 972, w: 54, h: 54 } },
    })
    expect(g).toBe(
      '[2:v]scale=324:81,format=rgba,pad=340:97:8:8:color=white,' +
      "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(hypot(max(0,abs(X-W/2)-(W/2-17)),max(0,abs(Y-H/2)-(H/2-17))),17),0,255)'," +
      'fade=t=in:st=8.5:d=0.4:alpha=1[logo];' +
      "[carded][logo]overlay=790:54:enable='gte(t,8.5)'[withlogo];" +
      `color=c=white:s=54x54:r=30:d=10,format=gbrp,${vegGeq('veg', 54)},format=rgba,fade=t=in:st=8.5:d=0.4:alpha=1[veg];` +
      "[withlogo][veg]overlay=1812:972:enable='gte(t,8.5)'[outv]")
  })
  it('a transparent logo gets a soft shadow instead of a plate (X2)', () => {
    const g = marksGraph({ ...base, logo: { size: { w: 388, h: 97 }, rect: { x: 766, y: 54, w: 388, h: 97 }, plated: false, layout: logoLayout(LAND, false) } })
    expect(g).toBe(
      '[2:v]scale=388:97,format=rgba,split[lgf][lgs];' +
      '[lgs]pad=404:113:8:8:color=black@0,colorchannelmixer=rr=0:gg=0:bb=0:aa=0.5,format=yuva444p,boxblur=luma_radius=4:luma_power=1:alpha_radius=4:alpha_power=1,fade=t=in:st=8.5:d=0.4:alpha=1[lgsh];' +
      '[lgf]fade=t=in:st=8.5:d=0.4:alpha=1[logo];' +
      "[carded][lgsh]overlay=762:50:enable='gte(t,8.5)'[shadowed];" +
      "[shadowed][logo]overlay=766:54:enable='gte(t,8.5)'[outv]")
  })
  it('the veg mark alone', () => {
    expect(marksGraph({ ...base, veg: { kind: 'non_veg', rect: { x: 54, y: 972, w: 54, h: 54 } } })).toBe(
      `color=c=white:s=54x54:r=30:d=10,format=gbrp,${vegGeq('non_veg', 54)},format=rgba,fade=t=in:st=8.5:d=0.4:alpha=1[veg];` +
      "[carded][veg]overlay=54:972:enable='gte(t,8.5)'[outv]")
  })
})
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/packshotMarks.test.ts`
Expected: FAIL with "Failed to resolve import ./packshotMarks.js".

- [ ] **Step 3: Write the module**

```ts
// apps/agent-orchestrator/src/mastra/tools/packshotMarks.ts
// TVC Part 2.2 (spec 2026-10-09 M3, M4, X1–X4, X9): the brand logo and the
// FSSAI veg / non-veg mark on the packshot, as pure rules. composite_end_card
// lays both in its one ffmpeg pass. Every size is a share of the REAL frame's
// shorter side; every filter string here is built from numbers and fixed
// words only — no user text ever reaches it.
import { LEGAL_BOX_PADDING, LEGAL_PLAY_RES_Y, legalAssFontSize, type Frame } from './legalText.js'
import type { Box } from './tvcChecks.js'

export const LOGO_IS_PRODUCT_PHOTO = 'LOGO_IS_PRODUCT_PHOTO: the logo is the product photo; ask the user for the brand\'s logo file (PNG or JPG)'
export const LOGO_NOT_RASTER = 'LOGO_NOT_RASTER: upload the logo as PNG or JPG'
export const LOGO_NOT_IMAGE = 'LOGO_NOT_IMAGE: the logo must be an image file (PNG or JPG); ask the user to upload one'
export const LOGO_UNCHECKED = 'LOGO_UNCHECKED: could not read the logo; try again'

export const LOGO_HEIGHT_SHARE = 0.09
export const LOGO_MAX_WIDTH_SHARE = 0.4
export const MARK_MARGIN_SHARE = 0.05
export const PLATE_PAD_SHARE = 0.08
const PLATE_RADIUS_SHARE = 0.18
const SHADOW_SHARE = 0.004
export const VEG_SIZE_SHARE = 0.05
/** The gap kept between the veg mark and the disclaimer box above it. */
const LEGAL_GAP_SHARE = 0.02
const MARK_DISSOLVE_SECONDS = 0.4
/** overlay_text's legal style: MarginV 160 from the bottom (PlayRes units). */
const LEGAL_MARGIN_V = 160

export type ImageKind = 'png' | 'jpeg' | 'webp' | 'svg' | 'other'
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** X3: what the logo file really is, from its bytes (never its name). */
export function sniffImage(buf: Buffer): ImageKind {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  const head = buf.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart()
  if (head.startsWith('<') && /<svg[\s>/]/i.test(head)) return 'svg'
  return 'other'
}

export const isSvgFile = (mimeType: string, pathname: string): boolean =>
  /^image\/svg/i.test(mimeType) || /\.svgz?$/i.test(pathname)

/** X2: a logo counts as transparent only when a decoded pixel is see-through,
 *  so an RGBA PNG whose alpha is all opaque (a white box baked in) still gets
 *  the plate. `rgba` is raw RGBA bytes. */
export function anyTransparent(rgba: Buffer): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 250) return true
  return false
}

export interface LogoLayout { boxW: number; boxH: number; pad: number; radius: number; margin: number; shadow: number }

/** M3/X1: the box the visible logo (its plate included) must fit. */
export function logoLayout(frame: Frame, plated: boolean): LogoLayout {
  const s = Math.min(frame.width, frame.height)
  const boxH = Math.round(LOGO_HEIGHT_SHARE * s)
  return {
    boxW: Math.round(LOGO_MAX_WIDTH_SHARE * frame.width),
    boxH,
    pad: plated ? Math.round(PLATE_PAD_SHARE * boxH) : 0,
    radius: plated ? Math.round(PLATE_RADIUS_SHARE * boxH) : 0,
    margin: Math.round(MARK_MARGIN_SHARE * s),
    shadow: plated ? 0 : Math.max(2, Math.round(SHADOW_SHARE * s)),
  }
}

/** X1: fit inside maxW x maxH, keeping the aspect ratio (a small logo is scaled up to the box). */
export function containSize(srcW: number, srcH: number, maxW: number, maxH: number): { w: number; h: number } {
  const k = Math.min(maxW / srcW, maxH / srcH)
  return { w: Math.max(1, Math.round(srcW * k)), h: Math.max(1, Math.round(srcH * k)) }
}

export type LogoSpot = 'top-center' | 'top-right' | 'top-left'
export type Corner = 'bottom-right' | 'bottom-left'
export interface Rect { x: number; y: number; w: number; h: number }

export function logoRect(spot: LogoSpot, frame: Frame, size: { w: number; h: number }, margin: number): Rect {
  const x = spot === 'top-center' ? Math.round((frame.width - size.w) / 2) : spot === 'top-left' ? margin : frame.width - margin - size.w
  return { x, y: margin, w: size.w, h: size.h }
}

function faceOverlap(rect: Rect, faces: Box[], frame: Frame): number {
  return faces.reduce((sum, f) => {
    const w = Math.min(rect.x + rect.w, f.x1 * frame.width) - Math.max(rect.x, f.x0 * frame.width)
    const h = Math.min(rect.y + rect.h, f.y1 * frame.height) - Math.max(rect.y, f.y0 * frame.height)
    return sum + (w > 0 && h > 0 ? w * h : 0)
  }, 0)
}

/** M3: top centre, or the first clear top corner; with none clear, the least overlap. */
export function chooseLogoSpot(faces: Box[], frame: Frame, size: { w: number; h: number }, margin: number): LogoSpot {
  const spots: LogoSpot[] = ['top-center', 'top-right', 'top-left']
  const overlaps = spots.map((s) => faceOverlap(logoRect(s, frame, size, margin), faces, frame))
  const clear = spots.find((_, i) => overlaps[i] === 0)
  return clear ?? spots[overlaps.indexOf(Math.min(...overlaps))]
}

export const vegSize = (frame: Frame): number => Math.max(16, Math.round(VEG_SIZE_SHARE * Math.min(frame.width, frame.height)))

/** The top edge (px) of overlay_text's legal box with `lines` lines: MarginV,
 *  the lines and the box padding, in PlayRes units scaled to the real height. */
export function legalBandTop(frame: Frame, lines: number): number {
  const playRes = LEGAL_MARGIN_V + lines * legalAssFontSize(frame) + 2 * LEGAL_BOX_PADDING
  return Math.floor(frame.height - playRes * frame.height / LEGAL_PLAY_RES_Y)
}

/** M4: inside the margin, and above the disclaimer box when one is on screen. */
export function vegRect(corner: Corner, frame: Frame, disclaimerLines?: number): Rect {
  const s = Math.min(frame.width, frame.height)
  const n = vegSize(frame)
  const margin = Math.round(MARK_MARGIN_SHARE * s)
  let bottom = frame.height - margin
  if (disclaimerLines) bottom = Math.min(bottom, legalBandTop(frame, disclaimerLines) - Math.round(LEGAL_GAP_SHARE * s))
  return { x: corner === 'bottom-right' ? frame.width - margin - n : margin, y: bottom - n, w: n, h: n }
}

/** M4: the bottom corner opposite the logo; the other one only to get off a face. */
export function vegCorner(logoSpot: LogoSpot | undefined, faces: Box[], frame: Frame, disclaimerLines?: number): Corner {
  const preferred: Corner = logoSpot === 'top-right' ? 'bottom-left' : 'bottom-right'
  const other: Corner = preferred === 'bottom-right' ? 'bottom-left' : 'bottom-right'
  const hit = (c: Corner) => faceOverlap(vegRect(c, frame, disclaimerLines), faces, frame) > 0
  return hit(preferred) && !hit(other) ? other : preferred
}

const VEG_RGB = [0, 128, 0] as const          // #008000
const NON_VEG_RGB = [139, 69, 19] as const    // #8B4513, the 2021 FSSAI non-veg colour

/** M4: the mark on an n×n white square: a square outline plus a filled dot
 *  (veg) or an upward triangle (non-veg). One geq; numbers only. */
export function vegGeq(kind: 'veg' | 'non_veg', n: number): string {
  const m = Math.round(n * 0.1)
  const t = Math.max(2, Math.round(n * 0.08))
  const c = (n - 1) / 2
  const border = `between(X,${m},${n - 1 - m})*between(Y,${m},${n - 1 - m})*(1-between(X,${m + t},${n - 1 - m - t})*between(Y,${m + t},${n - 1 - m - t}))`
  let shape: string
  if (kind === 'veg') {
    shape = `lte(hypot(X-${c},Y-${c}),${Math.round(n * 0.2)})`
  } else {
    const ty = Math.round(n * 0.3), by = Math.round(n * 0.7), hb = Math.round(n * 0.22)
    shape = `between(Y,${ty},${by})*lte(abs(X-${c})*${by - ty},(Y-${ty})*${hb})`
  }
  const [r, g, b] = kind === 'veg' ? VEG_RGB : NON_VEG_RGB
  const on = `gt(${border}+${shape},0)`
  return `geq=r='if(${on},${r},255)':g='if(${on},${g},255)':b='if(${on},${b},255)'`
}

export interface Marks {
  logo?: { size: { w: number; h: number }; rect: Rect; plated: boolean; layout: LogoLayout }
  veg?: { kind: 'veg' | 'non_veg'; rect: Rect }
  dissolveStart: number
  totalSeconds: number
  /** The ffmpeg input label of the logo, e.g. "[2:v]". */
  logoInput: string
}

const fadeIn = (st: number) => `fade=t=in:st=${st}:d=${MARK_DISSOLVE_SECONDS}:alpha=1`
const gate = (st: number) => `enable='gte(t,${st})'`

/** The marks as filter-graph text, from `from` (the carded video) to [outv].
 *  They dissolve in with the card. A plated logo sits on a rounded white
 *  plate; a transparent one gets a soft dark shadow (X2). */
export function marksGraph(m: Marks, from = '[carded]'): string {
  const parts: string[] = []
  const ds = m.dissolveStart
  let last = from
  if (m.logo) {
    const { size: { w, h }, rect, layout } = m.logo
    const out = m.veg ? '[withlogo]' : '[outv]'
    if (m.logo.plated) {
      const p = layout.pad, r = layout.radius
      parts.push(`${m.logoInput}scale=${w}:${h},format=rgba,pad=${w + 2 * p}:${h + 2 * p}:${p}:${p}:color=white,` +
        `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(hypot(max(0,abs(X-W/2)-(W/2-${r})),max(0,abs(Y-H/2)-(H/2-${r}))),${r}),0,255)',${fadeIn(ds)}[logo]`)
      parts.push(`${last}[logo]overlay=${rect.x}:${rect.y}:${gate(ds)}${out}`)
    } else {
      const s = layout.shadow
      parts.push(`${m.logoInput}scale=${w}:${h},format=rgba,split[lgf][lgs]`)
      parts.push(`[lgs]pad=${w + 4 * s}:${h + 4 * s}:${2 * s}:${2 * s}:color=black@0,colorchannelmixer=rr=0:gg=0:bb=0:aa=0.5,format=yuva444p,boxblur=luma_radius=${s}:luma_power=1:alpha_radius=${s}:alpha_power=1,${fadeIn(ds)}[lgsh]`)
      parts.push(`[lgf]${fadeIn(ds)}[logo]`)
      parts.push(`${last}[lgsh]overlay=${rect.x - s}:${rect.y - s}:${gate(ds)}[shadowed]`)
      parts.push(`[shadowed][logo]overlay=${rect.x}:${rect.y}:${gate(ds)}${out}`)
    }
    last = out
  }
  if (m.veg) {
    const n = m.veg.rect.w
    parts.push(`color=c=white:s=${n}x${n}:r=30:d=${m.totalSeconds},format=gbrp,${vegGeq(m.veg.kind, n)},format=rgba,${fadeIn(ds)}[veg]`)
    parts.push(`${last}[veg]overlay=${m.veg.rect.x}:${m.veg.rect.y}:${gate(ds)}[outv]`)
  }
  return parts.join(';')
}
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/packshotMarks.test.ts && pnpm --filter agent-orchestrator type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/packshotMarks.ts apps/agent-orchestrator/src/mastra/tools/packshotMarks.test.ts
git commit -m "feat(tvc-packshot): logo and veg-mark rules as pure code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `composite_end_card` lays the logo and the veg mark (M3, M4, X2–X4, X10)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/compositeEndCard.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/compositeEndCard.test.ts`

**Interfaces:**
- Consumes (Task 3): `LOGO_IS_PRODUCT_PHOTO`, `LOGO_NOT_RASTER`, `LOGO_NOT_IMAGE`, `anyTransparent`, `chooseLogoSpot`, `containSize`, `logoLayout`, `logoRect`, `marksGraph`, `sniffImage`, `vegCorner`, `vegRect`, the types `Marks` and `LogoSpot`; `type Box` from `./tvcChecks.js`.
- Produces:
  - Input schema adds `logoFileId?: string`, `vegMark?: 'veg' | 'non_veg'` and `disclaimerLines?: number` (int 1–2).
  - `endCardGraph(width, height, dissolveStart, holdSeconds = 0, card?, marks?: Marks): string`. With no marks (or marks with neither logo nor veg) it returns today's string. Otherwise it returns today's string with its final `[outv]` renamed `[carded]`, then `;` and `marksGraph(marks)`.
  - `inspectLogo(path: string): Promise<{ width: number; height: number; transparent: boolean }>`, which throws on an unreadable file.
  - The logo is ffmpeg input 2 (`[2:v]`), looped like the photo.

- [ ] **Step 1: Pin today's behaviour first** (these pass before any change; they guard Review Focus 1)

Append to `compositeEndCard.test.ts`:

```ts
const G_16_9 = "[1:v]split[bgsrc][fgsrc];[bgsrc]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=40:2,eq=brightness=-0.12[bg];[fgsrc]scale=1652:1080:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=rgba,fade=t=in:st=8.5:d=0.4:alpha=1[card];[0:v][card]overlay=0:0:enable='gte(t,8.5)'[outv]"
const G_HOLD = "[0:v]tpad=stop_mode=clone:stop_duration=1.5[base];[1:v]split[bgsrc][fgsrc];[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=40:2,eq=brightness=-0.12[bg];[fgsrc]scale=928:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=rgba,fade=t=in:st=19.95:d=0.4:alpha=1[card];[base][card]overlay=0:0:enable='gte(t,19.95)'[outv]"
const G_FACE = "[1:v]scale=360:1536:force_original_aspect_ratio=decrease,format=rgba,fade=t=in:st=5:d=0.4:alpha=1[card];[0:v][card]overlay=W*0.04:(H-h)/2:enable='gte(t,5)'[outv]"

describe('legacy end cards are byte-identical (X10, Review Focus 1)', () => {
  beforeEach(() => { vi.clearAllMocks() })
  it('endCardGraph without marks is unchanged', () => {
    expect(endCardGraph(1920, 1080, 8.5)).toBe(G_16_9)
    expect(endCardGraph(1080, 1920, 19.95, 1.5)).toBe(G_HOLD)
    expect(endCardGraph(1080, 1920, 5, 0, { scale: '360:1536', x: 'W*0.04' })).toBe(G_FACE)
  })
  it('execute without the new inputs: ffprobe then one ffmpeg, today\'s exact arguments', async () => {
    const { compositeEndCard } = await import('./compositeEndCard.js')
    const { uploadGeneratedFile } = await import('../../persistence.js')
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    isUnlimited.mockResolvedValue(false)
    resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 1_000 } })
    shouldRequireApproval.mockResolvedValue(false)
    fetchPresignedUrl.mockImplementation(async (fileId: string) => `https://cdn.example/${fileId}`)
    downloadToSessionCache.mockImplementation(async (_s: string, fileId: string) => ({ filePath: `/tmp/${fileId}.mp4`, buf: Buffer.from('x'), mimeType: 'video/mp4' }))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'carded1', name: 'carded.mp4', type: 'video/mp4', size: 8 })
    execFile.mockImplementation((cmd: string, _a: string[], _o: unknown, cb: (err: Error | null, res: { stdout: string; stderr: string }) => void) => {
      if (cmd === 'ffprobe') return cb(null, { stdout: JSON.stringify({ streams: [{ width: 1920, height: 1080 }], format: { duration: '10.0' } }), stderr: '' })
      cb(null, { stdout: '', stderr: '' })
    })
    const rc = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })) rc.set(k, v)
    const result = await compositeEndCard.execute!({ videoFileId: 'v1', productPhotoFileId: 'p1', aspectRatio: '16:9' } as never, { requestContext: rc, agent: { toolCallId: 'call-1' } } as never)
    expect(result).toMatchObject({ fileId: 'carded1' })
    expect(execFile.mock.calls.map((c) => c[0])).toEqual(['ffprobe', 'ffmpeg'])
    expect(execFile.mock.calls[1][1]).toEqual([
      '-y', '-i', '/tmp/v1.mp4',
      '-loop', '1', '-framerate', '30', '-t', '10', '-i', '/tmp/p1.mp4',
      '-filter_complex', G_16_9,
      '-map', '[outv]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      expect.stringMatching(/carded\.mp4$/),
    ])
  })
})
```

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/compositeEndCard.test.ts`
Expected: PASS. If it fails before any change, stop and report it.

- [ ] **Step 2: Write the failing tests** (append)

Add this import at the top of the file (`inputSchema` and `endCardGraph` already come from `./compositeEndCard.js`):

```ts
import { marksGraph } from './packshotMarks.js'

describe('endCardGraph with marks (M3, M4)', () => {
  it('renames today\'s [outv] to [carded] and appends the marks', () => {
    const marks = { dissolveStart: 8.5, totalSeconds: 10, logoInput: '[2:v]', veg: { kind: 'veg' as const, rect: { x: 1812, y: 972, w: 54, h: 54 } } }
    expect(endCardGraph(1920, 1080, 8.5, 0, undefined, marks)).toBe(`${G_16_9.slice(0, -'[outv]'.length)}[carded];${marksGraph(marks)}`)
    expect(endCardGraph(1920, 1080, 8.5, 0, undefined, { dissolveStart: 8.5, totalSeconds: 10, logoInput: '[2:v]' })).toBe(G_16_9)
  })
  it('the schema: string enums and a plain bounded number (no numeric enum)', () => {
    const json = JSON.stringify(inputSchema, (_k, v) => (v && typeof v === 'object' && v.typeName === 'ZodLiteral' && typeof v.value === 'number' ? '__NUMERIC_LITERAL__' : v))
    expect(json).not.toContain('__NUMERIC_LITERAL__')
    const ok = { videoFileId: 'v1', productPhotoFileId: 'p1', aspectRatio: '16:9' }
    expect(inputSchema.safeParse({ ...ok, logoFileId: 'l1', vegMark: 'non_veg', disclaimerLines: 2 }).success).toBe(true)
    expect(inputSchema.safeParse({ ...ok, vegMark: 'vegan' }).success).toBe(false)
    expect(inputSchema.safeParse({ ...ok, disclaimerLines: 3 }).success).toBe(false)
  })
})

describe('logo and veg mark on the packshot (M3, M4)', () => {
  beforeEach(() => { vi.clearAllMocks() })
  const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  const OPAQUE_RGBA = Buffer.alloc(16, 255)
  const CLEAR_RGBA = Buffer.from([255, 0, 0, 255, 0, 0, 0, 0])
  function setup(opts: { logoBuf?: Buffer; logoUnreadable?: boolean; rgba?: Buffer; faces?: Array<{ x0: number; y0: number; x1: number; y1: number }> } = {}) {
    isUnlimited.mockResolvedValue(false)
    resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 1_000 } })
    shouldRequireApproval.mockResolvedValue(false)
    fetchPresignedUrl.mockImplementation(async (id: string) => `https://cdn.example/${id}`)
    downloadToSessionCache.mockImplementation(async (_s: string, id: string) => ({
      filePath: `/tmp/${id}`, buf: id === 'logo1' ? (opts.logoBuf ?? PNG_HEAD) : Buffer.from('x'), mimeType: 'application/octet-stream',
    }))
    execFile.mockImplementation((cmd: string, args: string[], _o: unknown, cb: (err: Error | null, res?: { stdout: string | Buffer; stderr: string }) => void) => {
      if (cmd === 'ffprobe' && args[args.length - 1] === '/tmp/logo1') {
        return opts.logoUnreadable ? cb(new Error('Invalid data found when processing input')) : cb(null, { stdout: JSON.stringify({ streams: [{ width: 800, height: 200 }] }), stderr: '' })
      }
      if (cmd === 'ffprobe') return cb(null, { stdout: JSON.stringify({ streams: [{ width: 1920, height: 1080 }], format: { duration: '10.0' } }), stderr: '' })
      if (args.includes('rawvideo')) return cb(null, { stdout: opts.rgba ?? OPAQUE_RGBA, stderr: '' })
      cb(null, { stdout: '', stderr: '' })
    })
    if (opts.faces) {
      sampleFrames.mockResolvedValue([{ data: 'xx', mime: 'image/jpeg' }])
      faceBoxes.mockResolvedValue(opts.faces)
      chooseCardColumn.mockReturnValue('left')
    }
  }
  async function run(extra: Record<string, unknown>) {
    const { compositeEndCard } = await import('./compositeEndCard.js')
    const { uploadGeneratedFile } = await import('../../persistence.js')
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'carded1', name: 'carded.mp4', type: 'video/mp4', size: 8 })
    const rc = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })) rc.set(k, v)
    return compositeEndCard.execute!({ videoFileId: 'v1', productPhotoFileId: 'p1', aspectRatio: '16:9', ...extra } as never, { requestContext: rc, agent: { toolCallId: 'call-1' } } as never)
  }
  const composite = () => {
    const call = execFile.mock.calls.find((c) => c[0] === 'ffmpeg' && !(c[1] as string[]).includes('rawvideo'))!
    const args = call[1] as string[]
    return { args, graph: args[args.indexOf('-filter_complex') + 1] }
  }

  it('refuses LOGO_IS_PRODUCT_PHOTO before fetching anything (Review Focus 5)', async () => {
    setup()
    expect(await run({ logoFileId: 'p1' })).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^LOGO_IS_PRODUCT_PHOTO: /) })
    expect(fetchPresignedUrl).not.toHaveBeenCalled()
    expect(spendCredits).not.toHaveBeenCalled()
  })
  it.each([
    ['an SVG', Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'), 'LOGO_NOT_RASTER: upload the logo as PNG or JPG'],
    ['a GIF', Buffer.from('GIF89a......'), expect.stringMatching(/^LOGO_NOT_IMAGE: /)],
  ])('refuses %s logo before the charge or any ffmpeg (X3)', async (_n, logoBuf, reason) => {
    setup({ logoBuf })
    expect(await run({ logoFileId: 'logo1' })).toMatchObject({ refused: true, refusalReason: reason })
    expect(spendCredits).not.toHaveBeenCalled()
    expect(execFile).not.toHaveBeenCalled()
  })
  it('refuses LOGO_NOT_IMAGE when ffmpeg cannot read the logo, uncharged', async () => {
    setup({ logoUnreadable: true })
    expect(await run({ logoFileId: 'logo1' })).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^LOGO_NOT_IMAGE: /) })
    expect(spendCredits).not.toHaveBeenCalled()
  })
  it('a fully opaque logo gets the plate, top centre; the veg mark sits above a 2-line disclaimer; one composite pass', async () => {
    setup()
    expect(await run({ logoFileId: 'logo1', vegMark: 'veg', disclaimerLines: 2 })).toMatchObject({ fileId: 'carded1' })
    expect(spendCredits).toHaveBeenCalledTimes(1)
    expect(execFile.mock.calls.filter((c) => c[0] === 'ffmpeg' && !(c[1] as string[]).includes('rawvideo'))).toHaveLength(1)
    const { args, graph } = composite()
    expect(args.filter((a) => a === '-i')).toHaveLength(3)
    expect(args[args.indexOf('/tmp/logo1') - 1]).toBe('-i')
    expect(args.slice(args.indexOf('/tmp/logo1') - 7, args.indexOf('/tmp/logo1'))).toEqual(['-loop', '1', '-framerate', '30', '-t', '10', '-i'])
    expect(graph).toContain('[carded];[2:v]scale=324:81,format=rgba,pad=340:97:8:8:color=white,')
    expect(graph).toContain("[carded][logo]overlay=790:54:enable='gte(t,8.5)'[withlogo]")
    expect(graph).toContain("[withlogo][veg]overlay=1812:749:enable='gte(t,8.5)'[outv]")
  })
  it('a transparent logo is laid as it is, with a shadow (X2)', async () => {
    setup({ rgba: CLEAR_RGBA })
    await run({ logoFileId: 'logo1' })
    const { graph } = composite()
    expect(graph).toContain('[2:v]scale=388:97,format=rgba,split[lgf][lgs]')
    expect(graph).toContain("[shadowed][logo]overlay=766:54:enable='gte(t,8.5)'[outv]")
    expect(graph).not.toContain('color=white')
  })
  it('avoids a face in the top band: the logo moves to a clear top corner, the mark to the opposite bottom corner (Review Focus 4)', async () => {
    setup({ faces: [{ x0: 0.4, y0: 0.02, x1: 0.6, y1: 0.3 }] })
    await run({ logoFileId: 'logo1', vegMark: 'non_veg', avoidFaces: true })
    const { graph } = composite()
    expect(graph).toContain("[carded][logo]overlay=1526:54:enable='gte(t,8.5)'[withlogo]")
    expect(graph).toContain("[withlogo][veg]overlay=54:972:enable='gte(t,8.5)'[outv]")
  })
  it('the veg mark alone adds no input and no logo', async () => {
    setup()
    await run({ vegMark: 'veg' })
    const { args, graph } = composite()
    expect(args.filter((a) => a === '-i')).toHaveLength(2)
    expect(graph).toBe(`${G_16_9.slice(0, -'[outv]'.length)}[carded];${marksGraph({ dissolveStart: 8.5, totalSeconds: 10, logoInput: '[2:v]', veg: { kind: 'veg', rect: { x: 1812, y: 972, w: 54, h: 54 } } })}`)
  })
  it('disclaimerLines alone changes nothing', async () => {
    setup()
    await run({ disclaimerLines: 2 })
    expect(composite().graph).toBe(G_16_9)
  })
})
```

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/compositeEndCard.test.ts`
Expected: FAIL. The schema has no `vegMark`, and no logo is laid.

- [ ] **Step 3: Implement**

In `compositeEndCard.ts`:

1. Imports:

```ts
import { chooseCardColumn, faceBoxes, sampleFrames, type Box } from './tvcChecks.js'
import { LOGO_IS_PRODUCT_PHOTO, LOGO_NOT_IMAGE, LOGO_NOT_RASTER, anyTransparent, chooseLogoSpot, containSize, logoLayout, logoRect, marksGraph, sniffImage, vegCorner, vegRect, type LogoSpot, type Marks } from './packshotMarks.js'
```

2. Rename today's `endCardGraph` body to a private `cardGraph`, with the same parameters and body, unexported. Add the public wrapper:

```ts
/** The end card, plus (M3, M4) the logo and the veg mark in the same graph.
 *  With no marks this is exactly today's graph (X10). */
export function endCardGraph(width: number, height: number, dissolveStart: number, holdSeconds = 0, card?: { scale: string; x: string }, marks?: Marks): string {
  const graph = cardGraph(width, height, dissolveStart, holdSeconds, card)
  if (!marks || (!marks.logo && !marks.veg)) return graph
  return `${graph.slice(0, -'[outv]'.length)}[carded];${marksGraph(marks)}`
}
```

3. Add `inspectLogo` after `cardOverlayX`:

```ts
/** M3/X2/X4: the logo's size, and whether any pixel is see-through. The
 *  pixels are decoded at most 256 px wide (area scaling keeps partial alpha),
 *  so a huge logo costs nothing extra. Throws if ffmpeg can't read it. */
export async function inspectLogo(path: string): Promise<{ width: number; height: number; transparent: boolean }> {
  const { stdout } = await execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', path], { timeout: FFMPEG_TIMEOUT_MS })
  const stream = (JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> }).streams?.[0]
  if (!stream?.width || !stream?.height) throw new Error(`logo has no size: ${stdout}`)
  const { stdout: rgba } = await execFile('ffmpeg', [
    '-v', 'error', '-i', path, '-frames:v', '1',
    '-vf', "scale=w='min(256,iw)':h=-1:flags=area,format=rgba",
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
  ], { timeout: FFMPEG_TIMEOUT_MS, encoding: 'buffer', maxBuffer: 1 << 24 })
  return { width: stream.width, height: stream.height, transparent: anyTransparent(rgba) }
}
```

4. Schema: add after `avoidFaces`:

```ts
  logoFileId: z.string().optional().describe('TVC packshot: the brand logo the user uploaded (PNG or JPG). Laid top centre at 9% of the frame\'s shorter side, never over a face; a logo with no transparency sits on a rounded white plate. Never the product photo'),
  vegMark: z.enum(['veg', 'non_veg']).optional().describe('Food and drink packshot only: the FSSAI veg (green dot) or non-veg (brown triangle) mark, in the bottom corner opposite the logo'),
  disclaimerLines: z.number().int().min(1).max(2).optional().describe('From the TVC finish slice\'s endCard only: how many disclaimer lines will sit over the packshot, so the veg mark stays above them. Never guess it'),
```

5. `execute`:
   - Destructure `logoFileId`, `vegMark` and `disclaimerLines` too.
   - Right after the `idToken` check, add:

   ```ts
       // M3: the logo is never the product photo. Refused before anything is fetched or charged.
       if (logoFileId && logoFileId === productPhotoFileId) return { refused: true, refusalReason: LOGO_IS_PRODUCT_PHOTO, jobId }
   ```

   - Replace the download `try` block with:

   ```ts
    const scopeId = tenantId || sessionId
    let videoPath: string, photoPath: string
    let logoPath: string | undefined
    try {
      const [videoUrl, photoUrl, logoUrl] = await Promise.all([
        fetchPresignedUrl(videoFileId, idToken),
        fetchPresignedUrl(productPhotoFileId, idToken),
        logoFileId ? fetchPresignedUrl(logoFileId, idToken) : Promise.resolve(undefined),
      ])

      // E4: overlay_text marks the key of every video it burned a disclaimer
      // into; an end card laid over it would hide the disclaimer. Refused
      // before the charge, so this costs nothing.
      if (carriesLegalTextPath(videoUrl)) return { refused: true, refusalReason: END_CARD_OVER_DISCLAIMER, jobId }

      const [video, photo, logoFile] = await Promise.all([
        downloadToSessionCache(scopeId, videoFileId, videoUrl, MAX_SOURCE_BYTES),
        downloadToSessionCache(scopeId, productPhotoFileId, photoUrl, MAX_SOURCE_BYTES),
        logoFileId && logoUrl ? downloadToSessionCache(scopeId, logoFileId, logoUrl, MAX_SOURCE_BYTES) : Promise.resolve(undefined),
      ])
      videoPath = video.filePath
      photoPath = photo.filePath
      // X3: what the file really is, from its bytes, before any charge.
      if (logoFile) {
        const kind = sniffImage(logoFile.buf)
        if (kind === 'svg') return { refused: true, refusalReason: LOGO_NOT_RASTER, jobId }
        if (kind === 'other') return { refused: true, refusalReason: LOGO_NOT_IMAGE, jobId }
        logoPath = logoFile.filePath
      }
    } catch (err) {
      console.error(`[session:${sessionId}] compositeEndCard: failed to download sources:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    let logo: { width: number; height: number; transparent: boolean } | undefined
    if (logoPath) {
      try {
        logo = await inspectLogo(logoPath)
      } catch (err) {
        console.error(`[session:${sessionId}] compositeEndCard: logo unreadable:`, (err as Error).message)
        return { refused: true, refusalReason: LOGO_NOT_IMAGE, jobId }
      }
    }
   ```

   - In the face block, declare `let faces: Box[] = []` before `if (avoidFaces)`. Inside it, change `const faces = await faceBoxes(tenantId, frame)` to `faces = await faceBoxes(tenantId, frame)`. The rest of the block stays.
   - Replace the `const filterComplex = …` line with:

   ```ts
      // M3/M4: the logo and the veg mark join the same pass, sized from the real frame.
      const real = { width: videoWidth, height: videoHeight }
      let marks: Marks | undefined
      if (logo || vegMark) {
        marks = { dissolveStart, totalSeconds, logoInput: '[2:v]' }
        let spot: LogoSpot | undefined
        if (logo) {
          const layout = logoLayout(real, !logo.transparent)
          const size = containSize(logo.width, logo.height, layout.boxW - 2 * layout.pad, layout.boxH - 2 * layout.pad)
          const outer = { w: size.w + 2 * layout.pad, h: size.h + 2 * layout.pad }
          spot = chooseLogoSpot(faces, real, outer, layout.margin)
          marks.logo = { size, rect: logoRect(spot, real, outer, layout.margin), plated: !logo.transparent, layout }
        }
        if (vegMark) marks.veg = { kind: vegMark, rect: vegRect(vegCorner(spot, faces, real, disclaimerLines), real, disclaimerLines) }
      }
      const filterComplex = endCardGraph(videoWidth, videoHeight, dissolveStart, holdSeconds, cardOverride, marks)
   ```

   - In the ffmpeg arguments, right after `'-i', photoPath,`, add:

   ```ts
        ...(logoPath ? ['-loop', '1', '-framerate', '30', '-t', String(totalSeconds), '-i', logoPath] : []),
   ```

6. Append to the tool `description`: `' TVC packshot: logoFileId lays the brand logo top centre (9% of the shorter side; a logo with no transparency on a rounded white plate; never over a face) and vegMark the FSSAI veg or non-veg mark in the opposite bottom corner, above the disclaimer when disclaimerLines is given, all in the same pass. An SVG logo is refused with LOGO_NOT_RASTER, the product photo as the logo with LOGO_IS_PRODUCT_PHOTO, an unreadable one with LOGO_NOT_IMAGE, all uncharged.'`

- [ ] **Step 3b: Check the existing tests still pass with the new third `Promise.all` entry**

The old `'does not refuse a packshot clip with no disclaimer'` test rejects `downloadToSessionCache`. With no `logoFileId` that path still returns `SOURCE_UNAVAILABLE`, so nothing changes there.

- [ ] **Step 4: Run the tests and check that they pass**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/compositeEndCard.test.ts src/mastra/tools/packshotMarks.test.ts && pnpm --filter agent-orchestrator type-check`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/compositeEndCard.ts apps/agent-orchestrator/src/mastra/tools/compositeEndCard.test.ts
git commit -m "feat(end-card): brand logo and FSSAI veg mark on the packshot, same pass, refused before charge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: the plan carries motion, prices, the logo and the veg mark (M2, M3, M4, M5, X5, X7, X12)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/planTvc.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/tvcPlan.test.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/planTvc.test.ts`

**Interfaces:**
- Consumes: from Task 1, `MOTIONS`, `PRICE_MIN_SECONDS`, `priceError`, `priceSchema`, `priceTooShortReason`. From Task 3, `LOGO_IS_PRODUCT_PHOTO`, `LOGO_NOT_IMAGE`, `LOGO_NOT_RASTER`, `LOGO_UNCHECKED`, `isSvgFile`.
- Produces:
  - Shot: `motion?: Motion`, `price?: Price`. Packshot: `motion?: Motion`. Brief: `logoFileId?: string`, `vegMark?: 'veg' | 'non_veg'`.
  - `endCardInputs(plan: TvcPlan): { logoFileId?: string; vegMark?: 'veg' | 'non_veg'; disclaimerLines?: number } | undefined`
  - In the finish slice, each shot entry gains `motion` and `price` only when set, and the top level gains `endCard` only when `endCardInputs` returns one.
  - New plan errors: `PRICE_INVALID …`, `PRICE_MRP_NOT_HIGHER …` and `PRICE_TOO_SHORT: the price in shot <n> …`. New check refusals: `LOGO_IS_PRODUCT_PHOTO`, `LOGO_NOT_RASTER`, `LOGO_NOT_IMAGE` and `LOGO_UNCHECKED`.

- [ ] **Step 1: Write the failing tests**

Append to `tvcPlan.test.ts`. It uses `goodPlan`, `HY`, `sliceTvcPlan`, `validateTvcPlan` and `tvcPlanSchema`, all already in the file.

```ts
describe('Part 2.2: motion, prices, logo and veg mark in the plan (M2, M4, M5)', () => {
  it('check sets pop on shot text and fade on the tagline, and keeps what Director chose', () => {
    const p = goodPlan(); p.shots[1].text = 'Go'; p.shots[1].motion = 'slide_up'
    const out = validateTvcPlan(p).plan
    expect(out.shots[2].motion).toBe('pop')          // "SPF 30"
    expect(out.shots[1].motion).toBe('slide_up')
    expect(out.shots[0].motion).toBeUndefined()       // no text
    expect(out.packshot.motion).toBe('fade')
  })
  // Review Focus 2: a plan saved before this change was never checked by this code.
  it('an old saved plan slices exactly as before: no motion, price or endCard at slice time (X12)', () => {
    const slice = sliceTvcPlan(goodPlan(), 'finish')
    expect(JSON.stringify(slice)).not.toMatch(/motion|price|endCard|logoFileId|vegMark/)
    expect(Object.keys(slice as object)).toEqual(['brief', 'shots', 'voiceover', 'packshot', 'legal', 'narrationFileIds', 'songFileId'])
  })
  it('the finish slice carries each shot\'s motion and price', () => {
    const p = goodPlan(); p.shots[5].price = { amount: '₹499', mrp: '₹699', note: 'Launch offer' }
    const slice = sliceTvcPlan(validateTvcPlan(p).plan, 'finish') as { shots: Array<Record<string, unknown>>; packshot: Record<string, unknown> }
    expect(slice.shots[2]).toMatchObject({ n: 3, text: 'SPF 30', motion: 'pop' })
    expect(slice.shots[5]).toMatchObject({ n: 6, price: { amount: '₹499', mrp: '₹699', note: 'Launch offer' } })
    expect(slice.shots[5]).not.toHaveProperty('motion')
    expect(slice.packshot).toMatchObject({ tagline: 'Soft all day', motion: 'fade' })
  })
  it.each([
    [{ amount: 'cheap' }, /^PRICE_INVALID: "cheap" is not a price.*\(shot 6\)$/],
    [{ amount: '₹499', mrp: '₹499' }, /^PRICE_MRP_NOT_HIGHER: .*\(shot 6\)$/],
  ])('refuses a bad price %o', (price, reason) => {
    const p = goodPlan(); p.shots[5].price = price
    expect(validateTvcPlan(p).errors.some((e) => reason.test(e))).toBe(true)
  })
  it('refuses a price on a shot under 1.2 s (X7)', () => {
    const p = goodPlan()
    p.shots[3] = { ...p.shots[3], durationSeconds: 0.6, flashCut: true, price: { amount: '₹499' } }
    p.shots[6].durationSeconds = 3.9
    expect(validateTvcPlan(p).errors).toContain('PRICE_TOO_SHORT: the price in shot 4 is on screen for 0.6s; a price needs at least 1.2s. Put it on a shot of 1.2s or longer')
  })
  it('reminds about the offer disclaimer for an MRP, without inventing one', () => {
    const p = goodPlan(); p.shots[5].price = { amount: '₹499', mrp: '₹699' }
    const r = validateTvcPlan(p)
    expect(r.warnings.join(' ')).toMatch(/a price with an MRP is an offer claim/)
    expect(r.plan.legal).toEqual([])
  })
  it('the veg warning tells Director to set brief.vegMark, and goes once it is set (M5)', () => {
    const p = goodPlan(); p.brief.market = 'india'; p.brief.category = 'food'
    const w = validateTvcPlan(p).warnings.join(' ')
    expect(w).toMatch(/veg mark is recommended for food and drink \(an FSSAI packaging rule; common practice in TV ads\)/)
    expect(w).toMatch(/set brief\.vegMark \(veg or non_veg\) for food and drink/)
    expect(w).not.toMatch(/cannot be added yet/)
    p.brief.vegMark = 'veg'
    expect(validateTvcPlan(p).warnings.join(' ')).not.toMatch(/veg mark/)
  })
  it('endCard: the logo; the veg mark for food and drink only; disclaimer lines only when one is over the packshot', () => {
    const p = goodPlan(); p.brief.logoFileId = 'logo-1'; p.brief.vegMark = 'veg'
    const endCard = (plan: typeof p) => (sliceTvcPlan(plan, 'finish') as { endCard?: unknown }).endCard
    expect(endCard(p)).toEqual({ logoFileId: 'logo-1' })                         // beauty: no veg mark
    p.brief.category = 'food'
    expect(endCard(p)).toEqual({ logoFileId: 'logo-1', vegMark: 'veg' })
    p.legal = [{ text: HY, forVoiceoverBlock: 1 }]                               // 2–10s, gone before the 12s packshot
    expect(endCard(validateTvcPlan(p).plan)).toEqual({ logoFileId: 'logo-1', vegMark: 'veg' })
    p.legal = [{ text: HY, wholeAd: true }]                                      // 2 lines at 9:16, over the packshot
    expect(endCard(validateTvcPlan(p).plan)).toEqual({ logoFileId: 'logo-1', vegMark: 'veg', disclaimerLines: 2 })
  })
  it('the schema stays Gemini-safe: motion and vegMark are string enums', () => {
    const p = goodPlan(); p.shots[2].motion = 'stamp'; p.brief.vegMark = 'non_veg'
    expect(tvcPlanSchema.safeParse(p).success).toBe(true)
    expect(tvcPlanSchema.safeParse({ ...p, brief: { ...p.brief, vegMark: 'vegan' } }).success).toBe(false)
  })
})
```

Append to `planTvc.test.ts`:

```ts
describe('runPlanTvc check: the logo (M3, X3, X5)', () => {
  const withLogo = (id: string) => { const p = plan(); p.brief.logoFileId = id; return p }
  const photo = { mimeType: 'image/jpeg', pathname: '/generated/conv1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-product-photo.jpg' }
  it('refuses the product photo as the logo, before looking the logo up', async () => {
    const lookups: string[] = []
    const { deps, store } = fakeDeps({ productPhotoInfo: async (id) => { lookups.push(id); return photo } })
    const out = await runPlanTvc({ action: 'check', plan: withLogo('prod') }, deps)
    expect(out.refusalReason).toMatch(/^LOGO_IS_PRODUCT_PHOTO: /)
    expect(lookups).toEqual(['prod'])
    expect(store.size).toBe(0)
  })
  it.each([
    [{ mimeType: 'image/svg+xml', pathname: '/x/logo.svg' }, /^LOGO_NOT_RASTER: upload the logo as PNG or JPG$/],
    [{ mimeType: 'application/octet-stream', pathname: '/x/logo.svg' }, /^LOGO_NOT_RASTER: /],
    [{ mimeType: 'video/mp4', pathname: '/x/ad.mp4' }, /^LOGO_NOT_IMAGE: /],
  ])('refuses a logo that is %o', async (logoInfo, reason) => {
    const { deps, store } = fakeDeps({ productPhotoInfo: async (id) => (id === 'logo-1' ? logoInfo : photo) })
    expect((await runPlanTvc({ action: 'check', plan: withLogo('logo-1') }, deps)).refusalReason).toMatch(reason)
    expect(store.size).toBe(0)
  })
  it('refuses LOGO_UNCHECKED when the logo cannot be read', async () => {
    const { deps } = fakeDeps({ productPhotoInfo: async (id) => { if (id === 'logo-1') throw new Error('403'); return photo } })
    expect((await runPlanTvc({ action: 'check', plan: withLogo('logo-1') }, deps)).refusalReason).toBe('LOGO_UNCHECKED: could not read the logo; try again')
  })
  it('accepts a PNG logo and hands it to the end card through the finish slice', async () => {
    const { deps } = fakeDeps({ productPhotoInfo: async (id) => ({ mimeType: 'image/png', pathname: `/x/${id}.png` }) })
    const out = await runPlanTvc({ action: 'check', plan: withLogo('logo-1') }, deps)
    expect(out.errors).toEqual([])
    const finish = JSON.parse((await runPlanTvc({ action: 'get', planFileId: out.planFileId!, slice: 'finish' }, deps)).slice!)
    expect(finish.endCard).toEqual({ logoFileId: 'logo-1' })
  })
  // Review Focus 2: the old plan has no motion; the re-check writes pop into shot 1's text.
  it('a logo added to an old saved plan keeps its recorded stills and clips (X5, X12)', async () => {
    const { deps } = fakeDeps()
    const old = plan()
    old.shots[0].text = 'Ice cold'; old.shots[0].stillFileId = 's1'; old.shots[0].clipFileId = 'c1'; old.shots[2].clipFileId = 'c3'
    const id = await deps.save({ version: 1, storageKey: 'generated/conv/tvc-plan-old.json', plan: old })
    const again = plan(); again.shots[0].text = 'Ice cold'; again.brief.logoFileId = 'logo-1'
    const out = await runPlanTvc({ action: 'check', plan: again, planFileId: id! }, deps)
    expect(out.errors).toEqual([])
    const finish = JSON.parse((await runPlanTvc({ action: 'get', planFileId: id!, slice: 'finish' }, deps)).slice!)
    expect(finish.shots.map((s: { clipFileId?: string }) => s.clipFileId)).toEqual(['c1', undefined, 'c3'])
    expect(finish.shots[0].motion).toBe('pop')
    expect(finish.endCard).toEqual({ logoFileId: 'logo-1' })
  })
})
```

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/tvcPlan.test.ts src/mastra/tools/planTvc.test.ts`
Expected: FAIL. `motion` is not set, and there is no `endCard`.

- [ ] **Step 2: Implement in `tvcPlan.ts`**

1. Import:

```ts
import { MOTIONS, PRICE_MIN_SECONDS, priceError, priceSchema, priceTooShortReason } from './textMotion.js'
```

2. `shotSchema`: add after `flashCut`:

```ts
  motion: z.enum(MOTIONS).optional().describe('How this shot\'s text comes in; plan_tvc sets pop for a shot with text when it is missing'),
  price: priceSchema.optional().describe('A price or offer shown on this shot, e.g. {amount: "₹499", mrp: "₹699", note: "Launch offer"}; never also in text. The shot must be at least 1.2s'),
```

3. `brief`: add after `jingle`:

```ts
    logoFileId: z.string().optional().describe('The brand logo the user uploaded (PNG or JPG), laid on the packshot; never the product photo'),
    vegMark: z.enum(['veg', 'non_veg']).optional().describe('Food and drink: the veg or non-veg mark on the packshot'),
```

4. `packshot`: add `motion: z.enum(MOTIONS).optional().describe('How the tagline comes in; plan_tvc sets fade when missing'),`

5. In `validateTvcPlan`, after section 12 (short on-screen text):

```ts
  // 13. Text motion and prices (spec 2026-10-09 M1, M2, M5, X7). The default
  //     motion is written into the plan here, at check, so a plan saved
  //     before this change (never re-checked) stays static (X12).
  shots.forEach((s) => {
    if (s.text && !s.motion) s.motion = 'pop'
    if (!s.price) return
    const err = priceError(s.price)
    if (err) errors.push(`${err} (shot ${s.n})`)
    else if (s.durationSeconds < PRICE_MIN_SECONDS - EPS) errors.push(priceTooShortReason(s.durationSeconds, `the price in shot ${s.n}`))
  })
  if (plan.packshot.tagline && !plan.packshot.motion) plan.packshot.motion = 'fade'
```

6. In the India block, replace the veg `warnings.push(...)` line with:

```ts
    if ((brief.category === 'food' || brief.category === 'beverage') && !brief.vegMark) warnings.push('the veg mark is recommended for food and drink (an FSSAI packaging rule; common practice in TV ads); set brief.vegMark (veg or non_veg) for food and drink')
```

7. After the India block (before the public-place loop), add:

```ts
  // M2: an MRP next to a lower price is an offer claim; remind, never invent a disclaimer.
  if (shots.some((s) => s.price?.mrp) && !plan.legal.some((l) => !l.auto)) {
    warnings.push('a price with an MRP is an offer claim; ASCI expects a disclaimer for it (for example "Offer valid till stocks last"); ask the user for one')
  }
```

8. Add `endCardInputs` before `sliceTvcPlan`:

```ts
/** M3/M4: what composite_end_card needs. The veg mark is for food and drink
 *  only; disclaimerLines is the most lines of any disclaimer still on screen
 *  during the packshot, so the mark sits above that box. */
export function endCardInputs(plan: TvcPlan): { logoFileId?: string; vegMark?: 'veg' | 'non_veg'; disclaimerLines?: number } | undefined {
  const food = plan.brief.category === 'food' || plan.brief.category === 'beverage'
  const vegMark = food ? plan.brief.vegMark : undefined
  if (!plan.brief.logoFileId && !vegMark) return undefined
  const out: { logoFileId?: string; vegMark?: 'veg' | 'non_veg'; disclaimerLines?: number } = {}
  if (plan.brief.logoFileId) out.logoFileId = plan.brief.logoFileId
  if (vegMark) {
    out.vegMark = vegMark
    const packIdx = plan.shots.findIndex((s) => s.type === 'packshot')
    const packStart = packIdx >= 0 ? shotStarts(plan)[packIdx] : plan.brief.lengthSeconds
    const lines = legalTimings(plan).timings.reduce((n, t) => (t && t.endSeconds > packStart + EPS ? Math.max(n, t.lines) : n), 0)
    if (lines > 0) out.disclaimerLines = Math.min(lines, 2)
  }
  return out
}
```

9. In `sliceTvcPlan`'s finish branch:
   - Change the `shots:` line to:

   ```ts
      shots: plan.shots.map((s) => ({
        n: s.n, type: s.type, startSeconds: starts[s.n - 1], durationSeconds: s.durationSeconds, text: s.text, clipFileId: s.clipFileId,
        ...(s.motion ? { motion: s.motion } : {}),
        ...(s.price ? { price: s.price } : {}),
      })),
   ```

   - Inside `if (slice === 'finish') {`, before its `return {`, add `const endCard = endCardInputs(plan)`. Then add this just before the `finishOrder` spread:

   ```ts
      ...(endCard ? { endCard } : {}),
   ```

- [ ] **Step 3: Implement in `planTvc.ts`**

1. Import:

```ts
import { LOGO_IS_PRODUCT_PHOTO, LOGO_NOT_IMAGE, LOGO_NOT_RASTER, LOGO_UNCHECKED, isSvgFile } from './packshotMarks.js'
```

2. In `runPlanTvcUnlocked`, right after the `isExtractedFramePath` refusal, add:

```ts
    // M3: the logo is checked like the product photo, and is never the product photo itself.
    const logoFileId = planInput.brief.logoFileId
    if (logoFileId) {
      if (logoFileId === productPhotoFileId) return { refused: true, refusalReason: LOGO_IS_PRODUCT_PHOTO }
      let logoInfo: ProductPhotoInfo
      try {
        logoInfo = await deps.productPhotoInfo(logoFileId)
      } catch (err) {
        console.error('[planTvc] logo lookup failed:', (err as Error).message)
        return { refused: true, refusalReason: LOGO_UNCHECKED }
      }
      if (isSvgFile(logoInfo.mimeType, logoInfo.pathname)) return { refused: true, refusalReason: LOGO_NOT_RASTER }
      if (!looksLikeProductPhoto(logoInfo.mimeType, logoInfo.pathname)) return { refused: true, refusalReason: LOGO_NOT_IMAGE }
    }
```

3. In `carryOver`, change `strip` so overlay-only fields never count as a changed shot (X5, Review Focus 2):

```ts
  // motion and price only change overlay_text, never the picture: a re-check
  // that adds them (or writes the default pop into an old plan) keeps the
  // recorded still and clip.
  const strip = (s: TvcPlan['shots'][number]) => JSON.stringify({ ...s, stillFileId: undefined, clipFileId: undefined, motion: undefined, price: undefined })
```

4. Append to the `planTvc` tool `description`: `' check also validates prices (PRICE_INVALID, PRICE_MRP_NOT_HIGHER, PRICE_TOO_SHORT) and the logo (LOGO_IS_PRODUCT_PHOTO, LOGO_NOT_RASTER, LOGO_NOT_IMAGE, LOGO_UNCHECKED), and sets pop on shot text and fade on the tagline when no motion is given; the finish slice carries each shot\'s motion and price, and an endCard (logoFileId, vegMark, disclaimerLines) for composite_end_card.'`

- [ ] **Step 4: Run the tests and check that they pass**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/tvcPlan.test.ts src/mastra/tools/planTvc.test.ts src/mastra/tools/legalText.test.ts && pnpm --filter agent-orchestrator type-check`
Expected: PASS. These existing tests must pass unchanged:
- "a plan without a jingle slices and prices exactly as before"
- "lengthSeconds reaches Gemini without a numeric enum"
- "veg mark wording (L5)"
- "India food and beverage warns about the veg mark"

If an existing test compares a whole saved or validated plan with `toEqual` and now sees `motion: 'pop'`, update only that expectation to include it, and say so in the commit body.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts apps/agent-orchestrator/src/mastra/tools/tvcPlan.test.ts apps/agent-orchestrator/src/mastra/tools/planTvc.ts apps/agent-orchestrator/src/mastra/tools/planTvc.test.ts
git commit -m "feat(tvc-plan): text motion, prices, logo and veg mark; old plans stay static and keep their clips

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: real ffmpeg proves the motion, the logo size and the veg-mark corner

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/compositeEndCard.realffmpeg.test.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/overlayText.realffmpeg.test.ts` (append one `describe`)

**Interfaces:**
- Consumes: `compositeEndCard` (Task 4), `buildAss` with `motion` and `price` (Task 2), and the existing helpers in `overlayText.realffmpeg.test.ts` (`why`, `dir`, `grayClip`).
- Produces: nothing in code.

- [ ] **Step 1: Write the tagged end-card test**

```ts
// apps/agent-orchestrator/src/mastra/tools/compositeEndCard.realffmpeg.test.ts
// Real ffmpeg, not mocked. Tagged: runs only with RUN_REAL_FFMPEG=1.
// The end card needs no libass (lavfi, geq, boxblur, overlay, fade), so this
// also runs on a Mac with a stock ffmpeg.
import { describe, it, expect, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RequestContext } from '@mastra/core/request-context'

vi.mock('@serverless-saas/credits', () => ({ spendCredits: vi.fn(), resolveRate: vi.fn(async () => null), isUnlimited: vi.fn(async () => true), costMicro: () => 0n }))
vi.mock('../../usage.js', () => ({ getPool: vi.fn() }))
const uploaded: Buffer[] = []
vi.mock('../../persistence.js', () => ({
  uploadGeneratedFile: vi.fn(async (_t: string, i: { content: Buffer }) => { uploaded.push(i.content); return { fileId: 'out', name: 'o.mp4', type: 'video/mp4', size: i.content.length } }),
}))
const dir = mkdtempSync(join(tmpdir(), 'marks-real-'))
vi.mock('./mediaCache.js', () => ({
  fetchPresignedUrl: vi.fn(async (id: string) => `https://local.test/${id}`),
  downloadToSessionCache: vi.fn(async (_s: string, id: string) => {
    const filePath = join(dir, id)
    return { filePath, buf: readFileSync(filePath), mimeType: 'application/octet-stream' }
  }),
}))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval: vi.fn(async () => false) }))

import { compositeEndCard } from './compositeEndCard.js'

function whyNot(): string | null {
  if (!process.env.RUN_REAL_FFMPEG) return null
  const f = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' })
  if (f.error) return 'ffmpeg is not installed'
  for (const name of ['geq', 'boxblur', 'colorchannelmixer', 'overlay', 'fade']) {
    if (!new RegExp(`\\b${name}\\b`).test(f.stdout)) return `this ffmpeg has no ${name} filter`
  }
  return null
}
const why = whyNot()
if (why) console.warn(`[compositeEndCard.realffmpeg] SKIPPED: ${why}`)

const ff = (args: string[]) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args])
function inputs(W: number, H: number): string {
  const clip = `clip-${W}x${H}.mp4`
  ff(['-f', 'lavfi', '-i', `color=c=0x404040:s=${W}x${H}:d=3:r=30`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, clip)])
  ff(['-f', 'lavfi', '-i', 'color=c=0x305080:s=600x800', '-frames:v', '1', join(dir, 'photo.jpg')])
  // Opaque (rgb24 PNG): gets the plate. Clear: left half red, right half see-through.
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=800x200', '-frames:v', '1', join(dir, 'logo-opaque.png')])
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=800x200', '-vf', "format=rgba,geq=r='255':g='0':b='0':a='if(lt(X,400),255,0)'", '-frames:v', '1', join(dir, 'logo-clear.png')])
  return clip
}
function rgbFrame(video: string, at: number): Buffer {
  return execFileSync('ffmpeg', ['-loglevel', 'error', '-i', video, '-ss', String(at), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 })
}
function bbox(rgb: Buffer, W: number, H: number, test: (r: number, g: number, b: number) => boolean) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      if (!test(rgb[i], rgb[i + 1], rgb[i + 2])) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}
const isRed = (r: number, g: number, b: number) => r > 180 && g < 80 && b < 80
const isGreen = (r: number, g: number, b: number) => g > 90 && r < 70 && b < 70
const isBrown = (r: number, g: number, b: number) => r > 100 && r < 190 && g > 35 && g < 110 && b < 70 && r > g + 40

let n = 0
async function card(W: number, H: number, extra: Record<string, unknown>): Promise<Buffer> {
  const clip = inputs(W, H)
  const rc = new RequestContext()
  for (const [k, v] of Object.entries({ tenantId: 't', conversationId: 'c', idToken: 'tok' })) rc.set(k, v)
  const result = await compositeEndCard.execute!({ videoFileId: clip, productPhotoFileId: 'photo.jpg', aspectRatio: W > H ? '16:9' : '9:16', ...extra } as never, { requestContext: rc, agent: { toolCallId: `real-${++n}` } } as never)
  expect(result).toMatchObject({ fileId: 'out' })
  const out = join(dir, `out-${n}.mp4`)
  writeFileSync(out, uploaded[uploaded.length - 1])
  return rgbFrame(out, 2.8)                               // the card dissolved in at 1.5s and is full by 1.9s
}

describe.skipIf(!process.env.RUN_REAL_FFMPEG || !!why)('composite_end_card logo and veg mark against real ffmpeg', () => {
  it.each([[1920, 1080], [1080, 1920]])('a plated logo at %ix%i: 81 px of logo inside a 97 px plate, top centre', async (W, H) => {
    const red = bbox(await card(W, H, { logoFileId: 'logo-opaque.png' }), W, H, isRed)!
    console.log(`[compositeEndCard.realffmpeg] plated ${W}x${H}`, JSON.stringify(red))
    expect(Math.abs(red.h - 81)).toBeLessThanOrEqual(2)
    expect(Math.abs(red.y0 - (54 + 8))).toBeLessThanOrEqual(2)
    expect(Math.abs((red.x0 + red.x1) / 2 - W / 2)).toBeLessThanOrEqual(3)
  }, 120_000)
  it.each([[1920, 1080], [1080, 1920]])('a transparent logo at %ix%i is 97 px tall: 9% of the shorter side', async (W, H) => {
    const red = bbox(await card(W, H, { logoFileId: 'logo-clear.png' }), W, H, isRed)!
    console.log(`[compositeEndCard.realffmpeg] clear ${W}x${H}`, JSON.stringify(red))
    expect(Math.abs(red.h - 97)).toBeLessThanOrEqual(2)
    expect(Math.abs(red.y0 - 54)).toBeLessThanOrEqual(2)
  }, 120_000)
  it.each([
    [1920, 1080, undefined, 1026],
    [1920, 1080, 2, 803],
    [1080, 1920, 1, 1639],
  ])('the veg mark at %ix%i (disclaimer lines %s) sits bottom-right with its square ending at %i', async (W, H, lines, bottom) => {
    const g = bbox(await card(W, H, { vegMark: 'veg', ...(lines ? { disclaimerLines: lines } : {}) }), W, H, isGreen)!
    console.log(`[compositeEndCard.realffmpeg] veg ${W}x${H} lines=${lines}`, JSON.stringify(g))
    expect(g.x0).toBeGreaterThan(W / 2)
    expect(g.y0).toBeGreaterThan(H / 2)
    // The green outline runs from 5 to 48 inside the 54 px square.
    expect(g.w).toBeGreaterThanOrEqual(40)
    expect(g.w).toBeLessThanOrEqual(48)
    expect(Math.abs(g.y1 - (bottom - 6))).toBeLessThanOrEqual(2)
    expect(Math.abs(g.x1 - (W - 54 - 6))).toBeLessThanOrEqual(2)
  }, 120_000)
  it('the non-veg mark is brown, not green', async () => {
    const rgb = await card(1920, 1080, { vegMark: 'non_veg' })
    expect(bbox(rgb, 1920, 1080, isBrown)).not.toBeNull()
    expect(bbox(rgb, 1920, 1080, isGreen)).toBeNull()
  }, 120_000)
})
```

- [ ] **Step 2: Append the tagged motion test to `overlayText.realffmpeg.test.ts`**

It reuses the file's `why`, `dir`, `grayClip` and `buildAss`. Output seeking (`-ss` after `-i`) keeps the real timestamps the `subtitles` filter animates on.

```ts
describe.skipIf(!process.env.RUN_REAL_FFMPEG || !!why)('overlay_text motion against real ffmpeg + libass (M1, M2)', () => {
  it('a pop headline and a stamp price are still moving early and settled later', () => {
    const W = 1080, H = 1920
    const src = grayClip('motion', W, H)
    const ass = join(dir, 'motion.ass')
    writeFileSync(ass, buildAss([
      { text: 'Soft all day', startSeconds: 0.5, endSeconds: 2.8, position: 'top', size: 'large', motion: 'pop' },
      { text: '₹499', startSeconds: 0.5, endSeconds: 2.8, position: 'center', price: { amount: '₹499', mrp: '₹699', note: 'Launch offer' } },
    ], { width: W, height: H }))
    const at = (t: number): Buffer => {
      const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', src, '-ss', String(t), '-vf', `subtitles=${ass}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 })
      expect(r.status).toBe(0)
      return r.stdout
    }
    const early = at(0.56), late = at(1.5)
    const band = (buf: Buffer, y0: number, y1: number) => buf.subarray(y0 * W, y1 * W)
    const changed = (a: Buffer, b: Buffer) => { let k = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 40) k++; return k }
    const bright = (b: Buffer) => { let k = 0; for (const v of b) if (v > 200) k++; return k }
    const head = changed(band(early, 0, 480), band(late, 0, 480))
    const price = changed(band(early, 700, 1220), band(late, 700, 1220))
    console.log('[overlayText.realffmpeg] motion changed px', { head, price })
    expect(head).toBeGreaterThan(500)                       // the headline is mid-pop at 60 ms
    expect(price).toBeGreaterThan(500)                      // the price is mid-stamp at 60 ms
    expect(bright(band(late, 0, 480))).toBeGreaterThan(1000)     // and both are drawn once settled
    expect(bright(band(late, 700, 1220))).toBeGreaterThan(1000)
  }, 120_000)
})
```

- [ ] **Step 3: Run them untagged, then tagged**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/compositeEndCard.realffmpeg.test.ts src/mastra/tools/overlayText.realffmpeg.test.ts`
Expected: both suites skipped, 0 failures.

Run: `RUN_REAL_FFMPEG=1 pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/compositeEndCard.realffmpeg.test.ts`
Expected on a Mac with ffmpeg: PASS, with the measured boxes logged.
- If a logo height is off by more than 2 px, check `containSize` and the plate padding against the logged box before changing any test number.
- If the veg mark's bottom is off, check `legalBandTop`.
- Never widen a tolerance to make it pass.

Run: `RUN_REAL_FFMPEG=1 pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/overlayText.realffmpeg.test.ts`
Expected on the Mac (no libass): the suite skips with the libass install hint. On the VM it must PASS. That run is part of Deploy below.

- [ ] **Step 4: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/compositeEndCard.realffmpeg.test.ts apps/agent-orchestrator/src/mastra/tools/overlayText.realffmpeg.test.ts
git commit -m "test(tvc): real-ffmpeg proof of text motion, logo size and veg-mark corner (tagged)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: the skill text (M5), append only

**Files:**
- Modify (append only): `products/agent-platform/packages/api/seeds/official-skills/tvc-ad/director.md`
- Modify (append only): `products/agent-platform/packages/api/seeds/official-skills/tvc-ad.md`
- Test: `products/agent-platform/packages/api/__tests__/officialSkillsSeed.test.ts`

**Interfaces:**
- Consumes the names Tasks 2–5 put in front of Director:
  - Fields: `brief.logoFileId`, `brief.vegMark`, a shot's `price`, `motion`, and the finish slice's `endCard`.
  - Tool inputs: `logoFileId`, `vegMark`, `disclaimerLines`, `price`.
  - Reasons: `PRICE_INVALID`, `PRICE_MRP_NOT_HIGHER`, `PRICE_TOO_SHORT`, `LOGO_IS_PRODUCT_PHOTO`, `LOGO_NOT_RASTER`, `LOGO_NOT_IMAGE`, `LOGO_UNCHECKED`.
- Produces: nothing in code.

- [ ] **Step 1: Write the failing test**

Add these lines at the end of the `'tvc-ad follows the final-review rulings'` test, before its closing `});`:

```ts
    // Part 2.2: logo, veg mark, text motion and prices (additive section).
    expect(director).toMatch(/Logo, veg mark, text motion and prices \(supersede the matching lines above\)/)
    expect(director).toMatch(/write brief\.logoFileId from Olmo's "Logo: <fileId>"/)
    expect(director).toMatch(/brief\.vegMark \("veg" or "non_veg"\)/)
    expect(director).toMatch(/never in its text; that shot must be at least 1\.2 seconds/)
    expect(director).toMatch(/when the finish slice has endCard, pass its logoFileId, vegMark and disclaimerLines exactly as given/)
    expect(director).toMatch(/pass each shot's motion exactly as the finish slice gives it/)
    expect(director).toContain('LOGO_NOT_RASTER')
    expect(director).toContain('PRICE_TOO_SHORT')
    expect(card).toMatch(/18\. Logo, veg mark and prices \(supersedes the veg-mark part of item 8\)/)
    expect(card).toMatch(/"Logo: <fileId>"/)
    expect(card).toMatch(/"Veg mark: veg" or "Veg mark: non-veg"/)
    expect(card).toMatch(/"Price: <amount>; MRP: <higher price>; note: <short line>"/)
    // The shipped lines are still there, word for word (append only).
    expect(card).toMatch(/or the veg mark cannot be added yet/)
    expect(card).not.toMatch(/forVoiceoverBlock|overlay_text|plan_tvc|composite_end_card/)
```

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/officialSkillsSeed.test.ts`
Expected: FAIL on the first new expectation.

- [ ] **Step 2: Append to `tvc-ad/director.md`** (after its last line, with one blank line before)

```text

Logo, veg mark, text motion and prices (supersede the matching lines above):
- step plan: write brief.logoFileId from Olmo's "Logo: <fileId>" and, for food or beverage, brief.vegMark ("veg" or "non_veg") from "Veg mark:". Never use the product photo as the logo.
- step plan: a price from Olmo's "Price: …" goes in the price field ({amount, mrp, note}) of the shot where it shows, never in its text; that shot must be at least 1.2 seconds. Leave motion unset unless Olmo asks for a move; plan_tvc sets pop for shot text and fade for the tagline.
- On PRICE_INVALID, PRICE_MRP_NOT_HIGHER or PRICE_TOO_SHORT from plan_tvc check, fix what it says and check again. On LOGO_IS_PRODUCT_PHOTO, LOGO_NOT_RASTER, LOGO_NOT_IMAGE or LOGO_UNCHECKED, return the reason to Olmo.
- step finish, composite_end_card: when the finish slice has endCard, pass its logoFileId, vegMark and disclaimerLines exactly as given.
- step finish, overlay_text: pass each shot's motion exactly as the finish slice gives it (omit motion when the slice has none), and the packshot's motion with the tagline. For a shot with a price, add one overlay with price exactly as given, text = the price's amount, position center (top on the packshot), the shot's start and end, and no motion (it stamps in by itself). Legal entries never take a motion.
- composite_end_card or overlay_text refused with a LOGO_ or PRICE_ reason: return it to Olmo in plain words; never drop the logo or the price on your own.
```

- [ ] **Step 3: Append to `tvc-ad.md`** (after its last line, with one blank line before)

```text

18. Logo, veg mark and prices (supersedes the veg-mark part of item 8): when you plan a TVC, ask once, in plain words, for the brand's logo file ("Do you have your logo as a PNG or JPG? A see-through PNG looks best") and, for food or drink, whether the product is veg or non-veg. Pass "Logo: <fileId>" and "Veg mark: veg" or "Veg mark: non-veg" in the "step: plan" delegation. The logo and the veg mark appear on the ending only; with no logo the ending shows the product alone. When the user wants a price or an offer on screen, pass "Price: <amount>; MRP: <higher price>; note: <short line>" (the MRP and the note only when they gave them); an MRP next to a lower price is an offer claim, so ask for its disclaimer too. If Director reports the logo is the product photo, an SVG or not an image, ask for a PNG or JPG logo in one plain sentence. A logo given after the ad is made is another "step: plan" with the logo, then "step: finish".
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/officialSkillsSeed.test.ts`
Expected: PASS.

Then confirm that the files were only appended to:

Run: `git diff -U0 HEAD -- products/agent-platform/packages/api/seeds/official-skills/ | grep '^-[^-]' || echo "append-only OK"`
Expected: `append-only OK`.

- [ ] **Step 5: Run the whole orchestrator suite once**

Run: `pnpm --filter agent-orchestrator test && pnpm --filter agent-orchestrator type-check`
Expected: PASS (the real-ffmpeg suites are skipped).

- [ ] **Step 6: Commit**

```bash
git add -f products/agent-platform/packages/api/seeds/official-skills/tvc-ad/director.md products/agent-platform/packages/api/seeds/official-skills/tvc-ad.md
git add products/agent-platform/packages/api/__tests__/officialSkillsSeed.test.ts
git commit -m "feat(tvc-skill): ask for the logo and veg mark, pass motion, prices and the end card (append only)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Deploy (after merge; done by the user, not by an implementer)

1. **No migration and no credit-rate change.** `overlay_text` and `composite_end_card` keep their rates. The logo and the veg mark ride in the end card's single ffmpeg pass, so there is no new paid step and `tvcCreditSteps` is unchanged.
2. **Fonts:** the price super uses Noto Sans **Bold**. It ships in `fonts-noto-core`, which `./deploy-orch.sh` already installs since Part 2.1. To check by hand:

   ```bash
   fc-list "Noto Sans:style=Bold" family | head -1
   ```

   If it prints nothing, run `sudo apt-get install -y fonts-noto-core && fc-cache -f`.
3. **The real-ffmpeg proof on the VM:**

   ```bash
   cd apps/agent-orchestrator
   RUN_REAL_FFMPEG=1 pnpm exec vitest run src/mastra/tools/overlayText.realffmpeg.test.ts src/mastra/tools/compositeEndCard.realffmpeg.test.ts
   ```

   Both must PASS, not skip. The motion test logs its changed-pixel counts, and the end-card test logs every measured box.
4. **Orchestrator and the official skills:** run `./deploy-orch.sh`. It checks the fonts, seeds the official skills (the `director.md` and `tvc-ad.md` additions), builds, and restarts `agent-orchestrator`. Check that the `tvc-ad` skill's latest version contains "Logo, veg mark, text motion and prices".
5. **Web and the skills seed:** run `./deploy.sh`. It re-seeds the skills (idempotent) and rebuilds web. Web code is unchanged by this plan. No Lambda changes, so no `sam deploy`.
6. **Live test:** a 15 s India beverage ad, 16:9, with a transparent PNG logo, "veg", the price "₹49, MRP ₹60, Launch offer" on the shot before the packshot, and a disclaimer kept on for the whole ad.
   - Check the headline pops in, the price stamps in, and the tagline fades in.
   - Check the logo is top centre on the ending, with a soft shadow.
   - Check the green veg mark is bottom-right, above the disclaimer box.
   - Check the disclaimer stays still and on top.

   Then re-run "step: plan" with a JPG logo and confirm:
   - the recorded clips are kept;
   - the logo sits on a rounded white plate.

   Then try:
   - an SVG logo: it is refused in plain words before anything is paid;
   - a 9:16 version: the logo and the mark are the same pixel size as at 16:9.
