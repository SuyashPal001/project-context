# TVC Part 2.1: the Legal Disclaimer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every TVC disclaimer follows the ASCI rules by construction, in tool code: size from the real frame, an opaque box, at most 2 lines, a hold worked out by the ASCI formula, synced to the voiceover block that makes the claim, one disclaimer on screen at a time, and always the top layer over the end card.

**Architecture:**
- **`legalText.ts` (new, pure):** the ASCI numbers in one place. Font size from the frame's shorter side, a conservative width model and word wrap, word counting (brand, Rs, ₹, % not counted), the hold formula, and the key marker that tags a video carrying a disclaimer. `plan_tvc` and `overlay_text` both import it, so the plan and the render can never disagree on line count or hold.
- **`overlay_text` (L1, E5, E9, E11):** a new size value `"legal"`. Only when a call contains one does the tool probe the real frame, refuse `LEGAL_TOO_LONG` before charging, add three `*-legal` ASS styles (Noto Sans, `BorderStyle=3` black box, white text, bold off), hard-wrap the text with `\N`, keep the disclaimer at full size when avoiding faces, move other text out of its band, and upload under a key that carries the `legal-text` marker. A call with no `"legal"` overlay runs exactly today's code path.
- **Plan (`tvcPlan.ts`, L2, L3, L5, E3, E6, E7, E8, E10, E12):** `legal[]` gains `forVoiceoverBlock`, `wholeAd`, `linkedWith` and a computed `endSeconds`; `brief` gains `brandName`. `legalTimings()` computes every start and hold on every check and returns `LEGAL_TOO_LONG`, `LEGAL_HOLD_TOO_LONG`, `LEGAL_OVERLAP`, `LEGAL_CLAIM_MISSING` and `LEGAL_START_MISSING` as plan errors. The veg-mark warning says "recommended". The finish slice returns each legal line as `{ text, startSeconds, endSeconds, style: "legal" }`, plus `finishOrder` when the plan has legal lines.
- **E4 (end card never covers a disclaimer), enforced in code in two places:**
  1. The finish slice's `finishOrder` puts `composite_end_card` before `overlay_text`.
  2. `composite_end_card` refuses `END_CARD_OVER_DISCLAIMER`, before any charge, when its input video's storage key carries the `legal-text` marker, which `overlay_text` writes only when it burned a disclaimer.

  Because the order is fixed in code, `plan_tvc check` needs no separate "legal over the packshot" refusal.
- **Skill text (L4):** append-only sections in `tvc-ad/director.md` and `tvc-ad.md`.

**Tech Stack:** TypeScript, Mastra `createTool`, zod, vitest, ffmpeg/ffprobe with libass (`subtitles` filter) via `execFile`, fontconfig with Noto Sans + Noto Sans Devanagari (`fonts-noto-core`).

**Spec:** `docs/superpowers/specs/2026-10-07-tvc-legal-disclaimer-design.md` (L1–L5, E1–E12, §4, §5). Read it before your task.

## Global Constraints

- **Additive prompt changes only:** never delete or reword a shipped line in any skill or agent prompt. Append lines, and edit only `tvc-ad.md` and `tvc-ad/director.md`.
- **Paid tools:** charge first and refund on every failure path, exactly as today. Every new refusal (`LEGAL_TOO_LONG` in `overlay_text`, the frame probe failing, `END_CARD_OVER_DISCLAIMER`) happens **before** the charge. Do not touch `overlayTextCredits.ts` or `compositeEndCardCredits.ts`.
- **No numeric enums in tool schemas.** Gemini only accepts string enums. `size: 'legal'` is a string enum value (fine). `forVoiceoverBlock` is `z.number().int().min(1)`, never a literal union.
- **Existing callers unchanged:**
  - An `overlay_text` call with no `size: "legal"` overlay builds a byte-identical ASS file. For the pinned three-overlay input in Task 2, its sha256 is `57b41e1f0f04bf707c8173700d2569d76a2925221f3fdea2a7775de9611b2a5e`.
  - That call also makes exactly one `execFile` call (ffmpeg, no ffprobe) with the same arguments, and uploads through `uploadGeneratedFile` with the title `Video with Text Overlay`.
  - A plan with no legal lines slices to the same keys (`['brief', 'shots', 'voiceover', 'packshot', 'legal', 'narrationFileIds', 'songFileId']`) and prices the same.
- **ASCI numbers (copied from the spec):**
  - Em size = `ceil(0.046 × S)` px, where S is the frame's **shorter** side, so the lowercase x-height is ≥ 2.4% of S (≥ 26 px at 1080).
  - At most 2 lines. Text is never shrunk to fit.
  - Hold = `words/5 + (words ≤ 9 ? 2 : 3)`, where words = the disclaimer's words + all other on-screen words visible during it (shot texts and the packshot tagline). Then at least 4 s per line.
  - Not counted: `brief.brandName`, `Rs`, `Rs.`, `₹`, `%`, and a number attached to them (`₹499`, `50%`, `Rs 499`). A URL, an email and `T&C` are one word each. Hindi splits on spaces.
  - One disclaimer on screen at a time, except lines sharing the same `linkedWith`.
- **Rendering:**
  - Font `Noto Sans`, with Noto Sans Devanagari reached through fontconfig fallback (both ship in Debian's `fonts-noto-core`). Bold off, italic off.
  - Box: ASS `BorderStyle=3`, `OutlineColour` and `BackColour` `&H00000000` (opaque black), text `&H00FFFFFF`.
  - Always the bottom band. `avoidFaces` may move the band, never the size.
- **Plain reasons, verbatim:**
  - `LEGAL_TOO_LONG: the disclaimer "<first words…>" needs <n> lines; ASCI allows 2. Shorten it`
  - `LEGAL_HOLD_TOO_LONG: "<text>" needs <x>s on screen; start it earlier, shorten it, or keep it on for the whole ad`
  - `LEGAL_OVERLAP: only one disclaimer on screen at a time …`
  - `LEGAL_CLAIM_MISSING: legal line "<text>" points at voiceover block <n>, which doesn't exist`
  - Added by this plan: `LEGAL_START_MISSING`, `END_CARD_OVER_DISCLAIMER`.
- **Real tagged test:** `RUN_REAL_FFMPEG=1` only. Without it the suite is skipped. With it, but with no libass or no Noto fonts, the suite skips and prints how to install them.
- **Commits:** every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Add `docs/**/*.md` files with `git add -f` (the repo ignores `*.md`).
- **Where work happens:** the worktree `.claude/worktrees/tvc-live-fixes`, branch `text-overlay-legal`. Never `git stash`, never push.

## Review Focus

1. **`overlay_text` without `"legal"` must not change at all.** That covers the ASS bytes, the ffmpeg arguments, no extra ffprobe call, the same upload title and the same `positions`. A stray probe or a re-ordered style list would silently change every UGC and talking-head caption. Pinned in Task 2 ("legacy calls are byte-identical").
2. **The plan and the render must agree on line count at every real resolution.** If `plan_tvc` says 2 lines at the nominal frame but `overlay_text` counts 3 on a 1280×720 or 3840×2160 render, the finish fails after narration and music were already paid for. Pinned in Task 1 ("the line count depends only on the aspect ratio").
3. **Plans saved before this change still work.** A stored legal line is only `{ text, startSeconds }`, with no `endSeconds`. It must still validate, slice and get a computed hold. Pinned in Task 3 ("an old saved legal line still slices").
4. **Times Director writes itself cannot shorten a hold.** A Director-written `endSeconds`, or a `startSeconds` next to `forVoiceoverBlock`, is always overwritten by the computed value. Pinned in Task 3 ("Director's own times are overwritten").
5. **Face avoidance must never shrink a disclaimer or put another text on top of it.** That holds even when every band has a face. Pinned in Task 2 ("a disclaimer is never shrunk" and "other text leaves the disclaimer's band").

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/agent-orchestrator/src/mastra/tools/legalText.ts` (create) | Pure ASCI rules: `legalEmPx`, `legalAssFontSize`, `nominalFrame`, `legalTextWidthEm`, `wrapLegal`, `legalLineCount`, `countLegalWords`, `legalHoldSeconds`, `firstWords`, `LEGAL_TEXT_KEY_MARKER`, `carriesLegalTextPath` |
| `apps/agent-orchestrator/src/mastra/tools/legalText.test.ts` (create) | Unit tests for the above |
| `apps/agent-orchestrator/src/mastra/tools/overlayText.ts` (modify) | L1: `size: 'legal'`, frame probe, `LEGAL_TOO_LONG`, legal styles, `\N` wrap, face rules, band rule, marked upload key |
| `apps/agent-orchestrator/src/mastra/tools/overlayText.test.ts` (modify) | Legacy pins + legal tests |
| `apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts` (modify) | L2/L3/L5: schema fields, `legalTimings`, errors, veg message, finish slice, `finishOrder` |
| `apps/agent-orchestrator/src/mastra/tools/tvcPlan.test.ts` (modify) | Plan rule tests |
| `apps/agent-orchestrator/src/mastra/tools/planTvc.ts` (modify) | Tool description only |
| `apps/agent-orchestrator/src/mastra/tools/planTvc.test.ts` (modify) | Check refuses before saving; `wholeAd` saved |
| `apps/agent-orchestrator/src/mastra/tools/compositeEndCard.ts` (modify) | E4: `END_CARD_OVER_DISCLAIMER` before the charge |
| `apps/agent-orchestrator/src/mastra/tools/compositeEndCard.test.ts` (modify) | E4 test |
| `apps/agent-orchestrator/src/mastra/tools/overlayText.realffmpeg.test.ts` (create) | Tagged: x-height at 1920×1080, 2 lines in one box, no Devanagari tofu |
| `deploy-orch.sh` (modify) | Install `fonts-noto-core` on the VM if missing |
| `products/agent-platform/packages/api/seeds/official-skills/tvc-ad/director.md`, `tvc-ad.md` (modify, append only) | L4 |
| `products/agent-platform/packages/api/__tests__/officialSkillsSeed.test.ts` (modify) | Pins the appended lines |

---

### Task 1: the ASCI rules as pure code (`legalText.ts`)

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/legalText.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/legalText.test.ts`

**Interfaces:**
- Consumes: `generatedFileKey(conversationId, title, extension)` from `apps/agent-orchestrator/src/persistence.ts` (tests only).
- Produces (Tasks 2–5 import these exact names):
  - `interface Frame { width: number; height: number }`
  - `LEGAL_FONT = 'Noto Sans'`, `LEGAL_EM_SHARE = 0.046`, `LEGAL_FONT_HEIGHT_PER_EM = 1.362`, `LEGAL_PLAY_RES_Y = 1920`, `LEGAL_BOX_PADDING = 12`, `LEGAL_MAX_LINES = 2`, `LEGAL_SAFE_WIDTH_SHARE = 0.86`, `NOTO_SANS_X_HEIGHT_PER_EM = 0.536`, `LEGAL_TEXT_KEY_MARKER = 'legal-text'`
  - `nominalFrame(aspectRatio: '16:9' | '9:16'): Frame` (1920×1080 or 1080×1920)
  - `legalEmPx(frame: Frame): number`
  - `legalAssFontSize(frame: Frame): number` (ASS `Fontsize` on the 1080×1920 PlayRes canvas)
  - `legalTextWidthEm(text: string): number`
  - `wrapLegal(text: string, frame: Frame): string[]`
  - `legalLineCount(text: string, frame: Frame): number`
  - `countLegalWords(text: string, brandName?: string): number`
  - `legalHoldSeconds(text: string, alsoOnScreenWords?: number, opts?: { lines?: number; brandName?: string }): number`
  - `firstWords(text: string, n?: number): string`
  - `carriesLegalTextPath(urlOrKey: string): boolean`

**Why `LEGAL_FONT_HEIGHT_PER_EM`:** libass sizes a font the way VSFilter does. ASS `Fontsize` is the font's `usWinAscent + usWinDescent`, not its em. For Noto Sans that is (1069 + 293) / 1000 = 1.362 em. So the ASS size is the em px × 1.362, scaled from the real frame height to `PlayResY` 1920 (libass scales font size by frame height / PlayResY). The spec's "font px = ceil(0.046 × S)" is the **em** px, and Noto Sans's x-height is 0.536 em, so the x-height is ≥ 0.0247 × S. The real-ffmpeg test in Task 5 measures the result. If it measures low, raise this constant to match the measured ratio. Never lower the test's 26 px bar.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/agent-orchestrator/src/mastra/tools/legalText.test.ts
import { describe, it, expect } from 'vitest'
import { generatedFileKey } from '../../persistence.js'
import {
  LEGAL_FONT_HEIGHT_PER_EM, LEGAL_PLAY_RES_Y, LEGAL_TEXT_KEY_MARKER, NOTO_SANS_X_HEIGHT_PER_EM,
  carriesLegalTextPath, countLegalWords, firstWords, legalAssFontSize, legalEmPx, legalHoldSeconds,
  legalLineCount, nominalFrame, wrapLegal,
} from './legalText.js'

const X_TEXT = 'our new cream evens rare scars so an owner can wear more mascara as summer comes even nervous users are serene'
const THREE_LINES_16_9 = 'Results based on a consumer study of 120 women aged 25 to 40 over four weeks of daily use. Individual results may vary. Offer valid till stocks last. Prices include all taxes.'
const HY = 'Hyaluronic acid as per lab tests. T&C apply.'
const TWO_LINES_16_9 = 'Based on an independent lab test of moisture retention over eight hours. Results may vary.'
const HINDI = 'शर्तें लागू। परिणाम व्यक्ति के अनुसार अलग हो सकते हैं।'

const renderedEm = (f: { width: number; height: number }) => legalAssFontSize(f) * f.height / LEGAL_PLAY_RES_Y / LEGAL_FONT_HEIGHT_PER_EM

describe('legal font size (L1, E2: the shorter side)', () => {
  it.each([
    [{ width: 1080, height: 1920 }, 69],
    [{ width: 1920, height: 1080 }, 122],
    [{ width: 1080, height: 1080 }, 122],
  ])('%o: em 50 px, ASS size %i, x-height at least 26 px', (frame, assSize) => {
    expect(legalEmPx(frame)).toBe(50)
    expect(legalAssFontSize(frame)).toBe(assSize)
    expect(renderedEm(frame)).toBeGreaterThanOrEqual(50)
    expect(renderedEm(frame) * NOTO_SANS_X_HEIGHT_PER_EM).toBeGreaterThanOrEqual(26)
  })
  it.each([[{ width: 1024, height: 576 }], [{ width: 3840, height: 2160 }]])('%o: x-height scales with the shorter side (26 px per 1080)', (frame) => {
    const s = Math.min(frame.width, frame.height)
    expect(renderedEm(frame) * NOTO_SANS_X_HEIGHT_PER_EM).toBeGreaterThanOrEqual(26 * s / 1080)
  })
})

describe('wrapping (L1)', () => {
  it('wraps to the safe width and counts lines', () => {
    expect(wrapLegal(X_TEXT, nominalFrame('16:9'))).toEqual([
      'our new cream evens rare scars so an owner can wear more',
      'mascara as summer comes even nervous users are serene',
    ])
    expect(wrapLegal(HY, nominalFrame('9:16'))).toEqual(['Hyaluronic acid as per lab tests. T&C', 'apply.'])
    expect(legalLineCount('Creative visualisation', nominalFrame('16:9'))).toBe(1)
    expect(legalLineCount('Creative visualisation', nominalFrame('9:16'))).toBe(1)
    expect(legalLineCount(HY, nominalFrame('16:9'))).toBe(1)
    expect(legalLineCount(TWO_LINES_16_9, nominalFrame('16:9'))).toBe(2)
    expect(legalLineCount(THREE_LINES_16_9, nominalFrame('16:9'))).toBe(3)
  })
  it('counts a single word wider than the line as more than one line', () => {
    expect(legalLineCount('x'.repeat(120), nominalFrame('16:9'))).toBeGreaterThan(1)
  })
  it('measures Devanagari conservatively (never fewer lines than its Latin length suggests)', () => {
    expect(legalLineCount(HINDI, nominalFrame('16:9'))).toBe(1)
    expect(legalLineCount(HINDI, nominalFrame('9:16'))).toBe(2)
  })
  // Review Focus 2: the plan counts at the nominal frame, overlay_text at the real one.
  it('the line count depends only on the aspect ratio, never the resolution', () => {
    for (const text of [X_TEXT, THREE_LINES_16_9, HY, TWO_LINES_16_9, HINDI, 'Creative visualisation']) {
      const land = [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }].map((f) => legalLineCount(text, f))
      const port = [{ width: 720, height: 1280 }, { width: 1080, height: 1920 }, { width: 2160, height: 3840 }].map((f) => legalLineCount(text, f))
      expect(new Set(land).size).toBe(1)
      expect(new Set(port).size).toBe(1)
    }
  })
})

describe('word counting (E8)', () => {
  it.each([
    ['T&C apply', undefined, 2],
    ['Visit www.bubbli.in or write to care@bubbli.in', undefined, 6],
    ['Rs. 499 only', undefined, 1],
    ['Rs 99', undefined, 0],
    ['₹499 for 2 packs', undefined, 3],
    ['₹499/- inclusive', undefined, 1],
    ['50% off', undefined, 1],
    ['Bubbli Cola tastes best*', 'Bubbli Cola', 2],
    ['bubbli cola tastes best', 'Bubbli Cola', 2],
    ['Bubblicious taste', 'Bubbli', 2],
    ['शर्तें लागू', undefined, 2],
    ['- | *', undefined, 0],
  ])('%s (brand %s) = %i words', (text, brand, n) => {
    expect(countLegalWords(text, brand)).toBe(n)
  })
})

describe('hold (L2)', () => {
  it('words/5 + 2 up to 9 words, + 3 from 10, at least 4 s per line', () => {
    expect(legalHoldSeconds('Creative visualisation')).toBe(4)
    expect(legalHoldSeconds('one two three four five six seven eight nine')).toBe(4)
    expect(legalHoldSeconds('one two three four five six seven eight nine ten')).toBe(5)
    expect(legalHoldSeconds('a b c d e f g h i j k l m n o')).toBe(6)
    expect(legalHoldSeconds('one two three four five six seven eight nine', 3)).toBe(5.4)
    expect(legalHoldSeconds('Creative visualisation', 0, { lines: 2 })).toBe(8)
    expect(legalHoldSeconds('Bubbli one two three four five six seven eight nine', 0, { brandName: 'Bubbli' })).toBe(4)
  })
})

describe('helpers', () => {
  it('firstWords keeps six words and marks the cut', () => {
    expect(firstWords('one two three')).toBe('one two three')
    expect(firstWords('one two three four five six seven')).toBe('one two three four five six…')
  })
  it('recognises overlay_text\'s legal upload key, and nothing else (E4)', () => {
    const legalKey = generatedFileKey('c1', `${LEGAL_TEXT_KEY_MARKER} Video with Text Overlay`, 'mp4')
    expect(carriesLegalTextPath(`https://s3.example/${legalKey}?X-Amz-Signature=abc`)).toBe(true)
    expect(carriesLegalTextPath(legalKey)).toBe(true)
    expect(carriesLegalTextPath(`https://s3.example/${generatedFileKey('c1', 'Video with Text Overlay', 'mp4')}`)).toBe(false)
    expect(carriesLegalTextPath(`https://s3.example/${generatedFileKey('c1', 'my legal text notes', 'mp4')}`)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests and check that they fail**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/legalText.test.ts`
Expected: FAIL with "Failed to resolve import ./legalText.js".

- [ ] **Step 3: Write the module**

```ts
// apps/agent-orchestrator/src/mastra/tools/legalText.ts
// The ASCI disclaimer rules ("Guidelines for Disclaimers", amended 13 July
// 2023) as pure code. plan_tvc uses them to count lines and holds before any
// paid step; overlay_text uses the same functions to render. One source, so
// the plan and the render never disagree (spec 2026-10-07 L1, L2, E2, E8).

export interface Frame { width: number; height: number }

export const LEGAL_FONT = 'Noto Sans'
/** The em, as a share of the frame's SHORTER side (E2): x-height >= 2.4% of S, 26 px at 1080. */
export const LEGAL_EM_SHARE = 0.046
/** libass (like VSFilter) maps ASS Fontsize to usWinAscent+usWinDescent, not
 *  to the em. Noto Sans: (1069 + 293) / 1000. Measured by the real-ffmpeg test. */
export const LEGAL_FONT_HEIGHT_PER_EM = 1.362
export const NOTO_SANS_X_HEIGHT_PER_EM = 0.536
export const LEGAL_PLAY_RES_Y = 1920
export const LEGAL_BOX_PADDING = 12
export const LEGAL_MAX_LINES = 2
/** The share of the frame width a disclaimer line may fill: the 60-unit side
 *  margins (11%) plus the box padding, rounded down for safety. */
export const LEGAL_SAFE_WIDTH_SHARE = 0.86
const WIDTH_SAFETY = 1.05
/** overlay_text puts this in the storage key of every video it burned a
 *  disclaimer into, so composite_end_card can refuse to cover it (E4). */
export const LEGAL_TEXT_KEY_MARKER = 'legal-text'

export const nominalFrame = (aspectRatio: '16:9' | '9:16'): Frame =>
  aspectRatio === '16:9' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 }

export const legalEmPx = (frame: Frame): number => Math.ceil(LEGAL_EM_SHARE * Math.min(frame.width, frame.height))

export const legalAssFontSize = (frame: Frame): number =>
  Math.ceil(legalEmPx(frame) * LEGAL_FONT_HEIGHT_PER_EM * LEGAL_PLAY_RES_Y / frame.height)

// Noto Sans Regular advance widths in em (lowercase); everything else is
// rounded UP, so a line is never measured shorter than libass draws it.
const LOWER: Record<string, number> = {
  a: 0.561, b: 0.615, c: 0.48, d: 0.615, e: 0.564, f: 0.344, g: 0.615, h: 0.618, i: 0.258, j: 0.258, k: 0.534, l: 0.258, m: 0.935,
  n: 0.618, o: 0.605, p: 0.615, q: 0.615, r: 0.413, s: 0.479, t: 0.361, u: 0.618, v: 0.508, w: 0.786, x: 0.529, y: 0.51, z: 0.47,
}
function advanceEm(ch: string): number {
  if (ch === ' ') return 0.26
  if (LOWER[ch] !== undefined) return LOWER[ch]
  if (ch === 'M' || ch === 'W') return 0.93
  if (/[A-Z]/.test(ch)) return 0.7
  if (/[0-9]/.test(ch)) return 0.572
  if (/\p{Mn}/u.test(ch)) return 0
  if (/\p{Mc}/u.test(ch)) return 0.35
  if (/[ऀ-ॿ]/.test(ch)) return 0.75
  if (/[.,:;'!|]/.test(ch)) return 0.3
  return 0.75
}

export const legalTextWidthEm = (text: string): number =>
  [...text].reduce((sum, ch) => sum + advanceEm(ch), 0) * WIDTH_SAFETY

// Measured against the UNROUNDED em, so the count depends only on the
// frame's aspect ratio (Review Focus 2); rendering rounds the em up, which
// the 5% width safety covers.
const maxLineEm = (frame: Frame): number =>
  (LEGAL_SAFE_WIDTH_SHARE * frame.width) / (LEGAL_EM_SHARE * Math.min(frame.width, frame.height))

export function wrapLegal(text: string, frame: Frame): string[] {
  const max = maxLineEm(frame)
  const lines: string[] = []
  let current = ''
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word
    if (!current || legalTextWidthEm(next) <= max) current = next
    else { lines.push(current); current = word }
  }
  if (current) lines.push(current)
  return lines
}

export function legalLineCount(text: string, frame: Frame): number {
  const max = maxLineEm(frame)
  return wrapLegal(text, frame).reduce((n, line) => n + Math.max(1, Math.ceil(legalTextWidthEm(line) / max)), 0)
}

const CURRENCY_RE = /^(₹|rs\.?)$/i
const MONEY_OR_PERCENT_RE = /^((₹|rs\.?)[\d,.]+(\/-)?|[\d,.]+(₹|%)|%)$/i
const NUMBER_RE = /^[\d,.]+(\/-)?$/
const HAS_WORD_RE = /[\p{L}\p{N}]/u
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** E8: words ASCI counts. Not counted: the brand name, Rs, Rs., ₹, %, and a
 *  number attached to them. A URL, an email or T&C is one word (no spaces). */
export function countLegalWords(text: string, brandName?: string): number {
  let t = text
  const brand = brandName?.trim()
  if (brand) t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(brand)}(?![\\p{L}\\p{N}])`, 'giu'), ' ')
  let words = 0
  let afterCurrency = false
  for (const raw of t.split(/\s+/)) {
    const tok = raw.replace(/^[("'“‘[]+/u, '').replace(/[)"'”’\],;:!?.]+$/u, '')
    if (!tok) continue
    if (CURRENCY_RE.test(tok)) { afterCurrency = true; continue }
    if (MONEY_OR_PERCENT_RE.test(tok) || (afterCurrency && NUMBER_RE.test(tok))) { afterCurrency = false; continue }
    afterCurrency = false
    if (HAS_WORD_RE.test(tok)) words++
  }
  return words
}

/** L2: words/5 + (<= 9 words ? 2 : 3), counting other on-screen words; then at least 4 s per line. */
export function legalHoldSeconds(text: string, alsoOnScreenWords = 0, opts: { lines?: number; brandName?: string } = {}): number {
  const words = countLegalWords(text, opts.brandName) + alsoOnScreenWords
  const asci = words / 5 + (words <= 9 ? 2 : 3)
  const hold = Math.max(asci, 4 * (opts.lines ?? 1))
  return Math.ceil(hold * 10 - 1e-9) / 10
}

export function firstWords(text: string, n = 6): string {
  const words = text.trim().split(/\s+/)
  return words.length > n ? `${words.slice(0, n).join(' ')}…` : text.trim()
}

// Anchored on the 36-char uuid generatedFileKey puts first, so a title that
// merely contains "legal text" never matches (same pattern as planTvc's
// EXTRACTED_FRAME_PATH_RE).
const LEGAL_TEXT_PATH_RE = new RegExp(`/[0-9a-f-]{36}-${LEGAL_TEXT_KEY_MARKER}[-.]`, 'i')
export function carriesLegalTextPath(urlOrKey: string): boolean {
  let path = urlOrKey
  try { path = new URL(urlOrKey).pathname } catch { /* a bare storage key */ }
  return LEGAL_TEXT_PATH_RE.test(path)
}
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/legalText.test.ts && pnpm --filter agent-orchestrator type-check`
Expected: PASS, with no type errors. If a wrap expectation is off by one word, fix the **width table** (rounding up only) and not the expectation. The line-count invariance test must pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/legalText.ts apps/agent-orchestrator/src/mastra/tools/legalText.test.ts
git commit -m "feat(tvc): ASCI disclaimer rules as pure code (size, wrap, words, hold)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `overlay_text` gains the legal style (L1, E5, E9, E11)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/overlayText.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/overlayText.test.ts`

**Interfaces:**
- Consumes (Task 1): `Frame`, `LEGAL_FONT`, `LEGAL_BOX_PADDING`, `LEGAL_MAX_LINES`, `LEGAL_TEXT_KEY_MARKER`, `legalAssFontSize`, `legalLineCount`, `wrapLegal`, `firstWords`. From `../../persistence.js`: `uploadGeneratedFile` (unchanged), `uploadFileWithKey(idToken, { key, name, content, contentType })`, `generatedFileKey(conversationId, title, extension)`.
- Produces:
  - `TextOverlay.size?: 'small' | 'medium' | 'large' | 'legal'`
  - `buildAss(overlays: TextOverlay[], frame?: Frame): string`. It throws `Error('LEGAL_NEEDS_FRAME')` if a legal overlay comes without a frame.
  - `legalStyles(frame: Frame): string[]`
  - `resolveLegalBands(overlays: TextOverlay[]): TextOverlay[]` (returns the same array reference when there is no legal overlay)
  - `probeFrame(videoPath: string): Promise<Frame>`
  - Input schema: `size: z.enum(['small', 'medium', 'large', 'legal'])`. Refusal reason `LEGAL_TOO_LONG: …`.
  - A legal call's output key is `generatedFileKey(conversationId, 'legal-text Video with Text Overlay', 'mp4')`, and its display name is `Video with Text Overlay.mp4`.

- [ ] **Step 1: Pin today's behaviour first** (these tests pass before any code change; they guard Review Focus 1)

In `overlayText.test.ts`:
- Replace the `persistence.js` mock with one that also provides the two new functions.
- Wrap `writeFileSync` in the `node:fs` mock.
- Add `legalStyles, resolveLegalBands` to the import from `./overlayText.js`.

```ts
const { uploadGeneratedFile, uploadFileWithKey } = vi.hoisted(() => ({ uploadGeneratedFile: vi.fn(), uploadFileWithKey: vi.fn() }))
vi.mock('../../persistence.js', () => ({
  uploadGeneratedFile, uploadFileWithKey,
  generatedFileKey: (c: string, t: string, e: string) => `generated/${c}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-${t.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${e}`,
}))
```

```ts
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), writeFileSync: vi.fn(actual.writeFileSync) }
})
```

Append:

```ts
import { createHash } from 'node:crypto'

const LEGACY = [
  { text: "Don't wait", startSeconds: 0, endSeconds: 2, position: 'top' as const },
  { text: 'Soft all day', startSeconds: 12, endSeconds: 15, position: 'center' as const, size: 'large' as const },
  { text: 'Creative visualisation', startSeconds: 4, endSeconds: 8, position: 'bottom' as const, size: 'small' as const },
]
const LEGACY_SHA = '57b41e1f0f04bf707c8173700d2569d76a2925221f3fdea2a7775de9611b2a5e'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('legacy calls are byte-identical (Review Focus 1)', () => {
  it('buildAss without a legal overlay is unchanged', () => {
    expect(sha(buildAss(LEGACY))).toBe(LEGACY_SHA)
  })
  it('execute without a legal overlay: one ffmpeg call, same args, same ASS, same upload', async () => {
    execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (err: Error | null) => void) => cb(null))
    vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from('mp4'))
    uploadGeneratedFile.mockResolvedValueOnce({ fileId: 'out1', name: 'o.mp4', type: 'video/mp4', size: 3 })
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: LEGACY } as never, baseCtx())
    expect(result).toMatchObject({ fileId: 'out1', positions: ['top', 'center', 'bottom'] })
    expect(execFile).toHaveBeenCalledTimes(1)
    const [cmd, args] = execFile.mock.calls[0] as [string, string[]]
    expect(cmd).toBe('ffmpeg')
    expect(args.slice(0, 3)).toEqual(['-y', '-i', '/tmp/v1.mp4'])
    expect(args[3]).toBe('-vf')
    expect(args[4]).toMatch(/^subtitles=.*overlay\.ass$/)
    expect(args.slice(5)).toEqual(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', expect.stringMatching(/overlaid\.mp4$/)])
    const assWrite = vi.mocked(fs.writeFileSync).mock.calls.find((c) => String(c[0]).endsWith('overlay.ass'))!
    expect(sha(String(assWrite[1]))).toBe(LEGACY_SHA)
    expect(uploadGeneratedFile).toHaveBeenCalledWith('tok', expect.objectContaining({ conversationId: 'c1', title: 'Video with Text Overlay', extension: 'mp4' }))
    expect(uploadFileWithKey).not.toHaveBeenCalled()
  })
})
```

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/overlayText.test.ts`
Expected: PASS (this is a pin, not a red test). If it fails before any change, stop and report it: the pin is wrong, not the code.

- [ ] **Step 2: Write the failing legal tests** (append)

```ts
const LEGAL_X = 'our new cream evens rare scars so an owner can wear more mascara as summer comes even nervous users are serene'
const LEGAL_3 = 'Results based on a consumer study of 120 women aged 25 to 40 over four weeks of daily use. Individual results may vary. Offer valid till stocks last. Prices include all taxes.'
function probeAnd(width: number, height: number, ffmpeg: (cb: (err: (Error & { stderr?: string }) | null) => void) => void = (cb) => cb(null)) {
  execFile.mockImplementation((cmd: string, _a: string[], _o: unknown, cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void) => {
    if (cmd === 'ffprobe') return cb(null, { stdout: JSON.stringify({ streams: [{ width, height }] }), stderr: '' })
    ffmpeg(cb)
  })
}

describe('the legal style (L1)', () => {
  it('accepts size "legal" in the schema, as a string enum', () => {
    expect(inputSchema.safeParse({ videoFileId: 'v1', overlays: [{ ...okOverlay, size: 'legal' }] }).success).toBe(true)
  })
  it('adds three legal styles sized from the frame, after the unchanged ones', () => {
    const ass = buildAss([{ text: LEGAL_X, startSeconds: 0, endSeconds: 8, position: 'bottom', size: 'legal' }], { width: 1920, height: 1080 })
    expect(ass).toContain('Style: bottom-legal,Noto Sans,122,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,12,0,2,60,60,160,1')
    expect(ass).toContain('Style: top-legal,Noto Sans,122,')
    expect(ass.split('\n').filter((l) => l.startsWith('Style: '))).toHaveLength(12)
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:08.00,bottom-legal,,0,0,0,,our new cream evens rare scars so an owner can wear more\\Nmascara as summer comes even nervous users are serene')
    expect(legalStyles({ width: 1080, height: 1920 })[0]).toContain(',Noto Sans,69,')
  })
  it('refuses to build a legal overlay without the real frame', () => {
    expect(() => buildAss([{ ...okOverlay, size: 'legal' }])).toThrow('LEGAL_NEEDS_FRAME')
  })
  it('escapes ASS syntax in a disclaimer (E9)', () => {
    const ass = buildAss([{ text: '{T&C apply}\\', startSeconds: 0, endSeconds: 4, position: 'bottom', size: 'legal' }], { width: 1080, height: 1920 })
    expect(ass).toMatch(/bottom-legal,,0,0,0,,T&C apply$/m)
  })
  it('refuses LEGAL_TOO_LONG before charging or rendering', async () => {
    probeAnd(1920, 1080)
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [{ ...okOverlay, endSeconds: 9, text: LEGAL_3, size: 'legal' }] } as never, baseCtx())
    expect(result).toMatchObject({ refused: true, refusalReason: 'LEGAL_TOO_LONG: the disclaimer "Results based on a consumer study…" needs 3 lines; ASCI allows 2. Shorten it' })
    expect(spendCredits).not.toHaveBeenCalled()
    expect(execFile.mock.calls.map((c) => c[0])).toEqual(['ffprobe'])
  })
  it('refuses SOURCE_UNAVAILABLE, uncharged, when the frame cannot be probed', async () => {
    execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (err: Error | null) => void) => cb(new Error('probe failed')))
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [{ ...okOverlay, size: 'legal' }] } as never, baseCtx())
    expect(result).toMatchObject({ refused: true, refusalReason: 'SOURCE_UNAVAILABLE' })
    expect(spendCredits).not.toHaveBeenCalled()
  })
  it('puts a disclaimer at the bottom, sizes it from the probed frame, and uploads under the legal-text key', async () => {
    probeAnd(1920, 1080)
    vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from('mp4'))
    uploadFileWithKey.mockResolvedValueOnce({ fileId: 'out2', name: 'Video with Text Overlay.mp4', type: 'video/mp4', size: 3 })
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [{ ...okOverlay, endSeconds: 8, text: LEGAL_X, size: 'legal' }] } as never, baseCtx())
    expect(result).toMatchObject({ fileId: 'out2', positions: ['bottom'], creditsUsedMicro: '1000' })
    const assWrite = vi.mocked(fs.writeFileSync).mock.calls.find((c) => String(c[0]).endsWith('overlay.ass'))!
    expect(String(assWrite[1])).toContain('Style: bottom-legal,Noto Sans,122,')
    expect(uploadFileWithKey).toHaveBeenCalledWith('tok', expect.objectContaining({
      key: expect.stringMatching(/^generated\/c1\/[0-9a-f-]{36}-legal-text-video-with-text-overlay\.mp4$/),
      name: 'Video with Text Overlay.mp4', contentType: 'video/mp4',
    }))
    expect(uploadGeneratedFile).not.toHaveBeenCalled()
  })
  it('still refunds when ffmpeg fails on a legal call (charge-first unchanged)', async () => {
    probeAnd(1080, 1920, (cb) => cb(Object.assign(new Error('boom'), { stderr: 'boom' })))
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [{ ...okOverlay, size: 'legal' }] } as never, baseCtx())
    expect(result).toMatchObject({ refused: true, refusalReason: 'OVERLAY_FAILED' })
    expect(spendCredits).toHaveBeenCalledTimes(2)
    expect(spendCredits.mock.calls[1][0]).toMatchObject({ kind: 'refund' })
  })
})

describe('a disclaimer is never shrunk (E11, Review Focus 5)', () => {
  it('keeps size legal and its requested band when every band has a face', () => {
    const out = applyFacePlacement([{ text: 'T&C apply', startSeconds: 0, endSeconds: 4, position: 'bottom', size: 'legal' }], [[{ x0: 0, y0: 0, x1: 1, y1: 1 }]])
    expect(out[0]).toMatchObject({ position: 'bottom', size: 'legal' })
  })
  it('may move to a free band, still at full size', () => {
    const out = applyFacePlacement([{ text: 'T&C apply', startSeconds: 0, endSeconds: 4, position: 'bottom', size: 'legal' }], [[{ x0: 0.3, y0: 0.7, x1: 0.7, y1: 1 }]])
    expect(out[0].size).toBe('legal')
    expect(out[0].position).not.toBe('bottom')
  })
})

describe('other text leaves the disclaimer\'s band (E5, Review Focus 5)', () => {
  const legal = { text: 'T&C apply', startSeconds: 4, endSeconds: 8, position: 'bottom' as const, size: 'legal' as const }
  it('moves overlapping bottom text to center, and leaves text outside the window alone', () => {
    const out = resolveLegalBands([legal, { text: 'SPF 30', startSeconds: 5, endSeconds: 6, position: 'bottom' }, { text: 'Hi', startSeconds: 0, endSeconds: 2, position: 'bottom' }])
    expect(out.map((o) => o.position)).toEqual(['bottom', 'center', 'bottom'])
  })
  it('moves the tagline to the top when a face pushed the disclaimer to center', () => {
    const out = resolveLegalBands([{ ...legal, position: 'center' }, { text: 'Soft all day', startSeconds: 6, endSeconds: 9, position: 'center', size: 'large' }])
    expect(out[1]).toMatchObject({ position: 'top', size: 'large' })
  })
  it('returns the very same array when there is no disclaimer', () => {
    const input = [okOverlay]
    expect(resolveLegalBands(input)).toBe(input)
  })
})
```

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/overlayText.test.ts`
Expected: FAIL. `legalStyles` and `resolveLegalBands` are not exported, and the schema rejects `'legal'`.

- [ ] **Step 3: Implement**

In `overlayText.ts`:

Imports: change the persistence import line and add the legalText import.

```ts
import { generatedFileKey, uploadFileWithKey, uploadGeneratedFile } from '../../persistence.js'
import { LEGAL_BOX_PADDING, LEGAL_FONT, LEGAL_MAX_LINES, LEGAL_TEXT_KEY_MARKER, firstWords, legalAssFontSize, legalLineCount, wrapLegal, type Frame } from './legalText.js'
```

Types (replace the `TextOverlay` interface):

```ts
export type OverlaySize = keyof typeof FONT_SIZES | 'legal'

export interface TextOverlay {
  text: string
  startSeconds: number
  endSeconds: number
  position: keyof typeof ALIGNMENTS
  size?: OverlaySize
}
```

`applyFacePlacement`: insert one line before the existing `return`.

```ts
    const { position, shrink } = chooseTextPosition(faces, o.position)
    // E11: a disclaimer keeps its ASCI size; only its band may change, and
    // with no free band it stays where it was asked to be.
    if (o.size === 'legal') return { ...o, position: shrink ? o.position : position }
    return { ...o, position, ...(shrink ? { size: 'small' as const } : {}) }
```

New helpers (above `buildAss`):

```ts
/** L1: the disclaimer style. Opaque black box (BorderStyle 3), white text, bold
 *  and italic off, sized from the REAL frame so it lands at the ASCI size. */
export function legalStyles(frame: Frame): string[] {
  const size = legalAssFontSize(frame)
  return (Object.keys(ALIGNMENTS) as (keyof typeof ALIGNMENTS)[]).map((pos) =>
    `Style: ${pos}-legal,${LEGAL_FONT},${size},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,${LEGAL_BOX_PADDING},0,${ALIGNMENTS[pos]},60,60,${pos === 'center' ? 0 : 160},1`)
}

/** E5: while a disclaimer is on screen it owns its band; other text in that
 *  band moves to the first band no disclaimer holds (center, then top). */
export function resolveLegalBands(overlays: TextOverlay[]): TextOverlay[] {
  const legal = overlays.filter((o) => o.size === 'legal')
  if (legal.length === 0) return overlays
  return overlays.map((o) => {
    if (o.size === 'legal') return o
    const during = legal.filter((l) => l.startSeconds < o.endSeconds && o.startSeconds < l.endSeconds)
    if (!during.some((l) => l.position === o.position)) return o
    const taken = new Set(during.map((l) => l.position))
    const free = (['center', 'top', 'bottom'] as const).find((p) => !taken.has(p))
    return free ? { ...o, position: free } : o
  })
}

export async function probeFrame(videoPath: string): Promise<Frame> {
  const { stdout } = await execFile('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', videoPath,
  ], { timeout: FFMPEG_TIMEOUT_MS })
  const stream = (JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> }).streams?.[0]
  if (!stream?.width || !stream?.height) throw new Error(`ffprobe gave no frame size: ${stdout}`)
  return { width: stream.width, height: stream.height }
}

const dialogueText = (o: TextOverlay, frame?: Frame): string =>
  o.size === 'legal' && frame ? wrapLegal(escapeAssText(o.text), frame).join('\\N') : escapeAssText(o.text)
```

`buildAss`: change the signature and two lines, leaving everything else as is.

```ts
export function buildAss(overlays: TextOverlay[], frame?: Frame): string {
  const hasLegal = overlays.some((o) => o.size === 'legal')
  if (hasLegal && !frame) throw new Error('LEGAL_NEEDS_FRAME')
  const styles = (Object.keys(ALIGNMENTS) as (keyof typeof ALIGNMENTS)[])
    .flatMap((pos) => (Object.keys(FONT_SIZES) as (keyof typeof FONT_SIZES)[]).map((size) =>
      `Style: ${pos}-${size},DejaVu Sans,${FONT_SIZES[size]},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,4,1,${ALIGNMENTS[pos]},60,60,${pos === 'center' ? 0 : 160},1`))
  if (hasLegal) styles.push(...legalStyles(frame!))
  const events = overlays.map((o) =>
    `Dialogue: 0,${formatAssTimestamp(o.startSeconds)},${formatAssTimestamp(o.endSeconds)},${o.position}-${o.size ?? 'medium'},,0,0,0,,${dialogueText(o, frame)}`)
  // ...the return [...] block is unchanged
```

Schema: change the `size` line.

```ts
    size: z.enum(['small', 'medium', 'large', 'legal']).optional().describe('Defaults to medium. "legal" is only for a disclaimer: ASCI size from the real frame, an opaque box, at most 2 lines, always the bottom band'),
```

Tool `description`: append this sentence at the end of the existing string.

`' Size "legal" is the disclaimer style (ASCI size worked out from the real frame, opaque box, at most 2 lines, bottom); a disclaimer that needs more than 2 lines is refused with LEGAL_TOO_LONG, uncharged.'`

`execute`:

1. Right after the `INVALID_OVERLAY` check, add:

```ts
    const hasLegal = overlays.some((o) => o.size === 'legal')
    // L1: a disclaimer always asks for the bottom band (avoidFaces may still move it).
    const requested: TextOverlay[] = hasLegal ? overlays.map((o) => (o.size === 'legal' ? { ...o, position: 'bottom' as const } : o)) : overlays
```

2. Right after the download `try/catch` and **before** `const attempt = 0`, add:

```ts
    // L1: the frame decides the legal size and the line count; both are
    // checked before the charge, so a refusal here costs nothing.
    let frame: Frame | undefined
    if (hasLegal) {
      try {
        frame = await probeFrame(videoPath)
      } catch (err) {
        console.error(`[session:${sessionId}] overlayText: frame probe failed:`, (err as Error).message)
        return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
      }
      for (const o of requested) {
        if (o.size !== 'legal') continue
        const lines = legalLineCount(escapeAssText(o.text), frame)
        if (lines > LEGAL_MAX_LINES) {
          return { refused: true, refusalReason: `LEGAL_TOO_LONG: the disclaimer "${firstWords(o.text)}" needs ${lines} lines; ASCI allows 2. Shorten it`, jobId }
        }
      }
    }
```

3. In the face block, replace `let placed = overlays` with `let placed = requested`. Inside it, replace `overlays.map(async (o) =>` with `requested.map(async (o) =>`, and replace `applyFacePlacement(overlays, faces)` with `applyFacePlacement(requested, faces)`. After the whole `if (avoidFaces) { ... }` block, add:

```ts
    placed = resolveLegalBands(placed)
```

4. Replace `writeFileSync(assPath, buildAss(placed))` with `writeFileSync(assPath, buildAss(placed, frame))`.

5. Replace the upload call:

```ts
    // E4: a video carrying a disclaimer is stored under a key with the
    // legal-text marker, so composite_end_card can refuse to cover it.
    const attachment = hasLegal
      ? await uploadFileWithKey(idToken, {
        key: generatedFileKey(conversationId, `${LEGAL_TEXT_KEY_MARKER} Video with Text Overlay`, 'mp4'),
        name: 'Video with Text Overlay.mp4', content: buffer, contentType: 'video/mp4',
      })
      : await uploadGeneratedFile(idToken, {
        conversationId, title: 'Video with Text Overlay', content: buffer,
        contentType: 'video/mp4', extension: 'mp4',
      })
```

- [ ] **Step 4: Run the tests and check that they pass**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/overlayText.test.ts src/mastra/tools/legalText.test.ts && pnpm --filter agent-orchestrator type-check`
Expected: PASS, including every pre-existing test in `overlayText.test.ts` with no edits to it beyond the two mock changes in Step 1.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/overlayText.ts apps/agent-orchestrator/src/mastra/tools/overlayText.test.ts
git commit -m "feat(overlay-text): legal disclaimer style sized from the real frame, 2-line limit, boxed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: the plan computes every disclaimer's start and hold (L2, L3, L4 slice, L5)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts`
- Modify: `apps/agent-orchestrator/src/mastra/tools/planTvc.ts` (description only)
- Test: `apps/agent-orchestrator/src/mastra/tools/tvcPlan.test.ts`, `apps/agent-orchestrator/src/mastra/tools/planTvc.test.ts`

**Interfaces:**
- Consumes (Task 1): `countLegalWords`, `legalHoldSeconds`, `legalLineCount`, `nominalFrame`, `firstWords`, `LEGAL_MAX_LINES`.
- Produces:
  - `legalLineSchema`: `{ text: string; forVoiceoverBlock?: number /* int ≥ 1, 1 = the first block */; startSeconds?: number; wholeAd?: boolean; linkedWith?: string; endSeconds?: number /* computed */ }`
  - `brief.brandName?: string`
  - `interface LegalTiming { text: string; startSeconds: number; endSeconds: number; lines: number }`
  - `legalTimings(plan: TvcPlan): { timings: Array<LegalTiming | null>; errors: string[] }`
  - `finishOrder(plan: TvcPlan): string[]`
  - `legalHoldSeconds` is re-exported from `tvcPlan.ts`, so existing imports keep working.
  - The finish slice's `legal` is now `Array<{ text; startSeconds; endSeconds; style: 'legal' }>`. The slice also has `finishOrder` **only when** `plan.legal.length > 0`.

- [ ] **Step 1: Write the failing tests**

In `tvcPlan.test.ts`:
- Add `legalTimings, finishOrder` to the first import line.
- Change the one existing expectation in "India adds "Creative visualisation" for a mechanism shot, once" from `toEqual([{ text: 'Creative visualisation', startSeconds: 4 }])` to `toEqual([{ text: 'Creative visualisation', startSeconds: 4, endSeconds: 8 }])`. The spec now stores the computed end. That test's other lines stay.
- Append:

```ts
const HY = 'Hyaluronic acid as per lab tests. T&C apply.'          // 2 lines at 9:16, 8 words
const SHORT = 'As per lab test. Results may vary.'                  // 1 line, 7 words
const LONG_9_16 = 'Based on an independent lab test of moisture retention over eight hours. Results may vary.' // 3 lines at 9:16

describe('legal lines (L2, L3)', () => {
  it('starts at the claim\'s voiceover block and holds 4 s per line', () => {
    const p = goodPlan(); p.legal = [{ text: HY, forVoiceoverBlock: 1 }]
    const r = validateTvcPlan(p)
    expect(r.errors).toEqual([])
    expect(r.plan.legal[0]).toMatchObject({ startSeconds: 2, endSeconds: 10 })
  })
  it('Director\'s own times are overwritten (Review Focus 4)', () => {
    const p = goodPlan(); p.legal = [{ text: HY, forVoiceoverBlock: 1, startSeconds: 7, endSeconds: 3 }]
    expect(validateTvcPlan(p).plan.legal[0]).toMatchObject({ startSeconds: 2, endSeconds: 10 })
  })
  it('re-check recomputes the start from the current voiceover (E7, E12)', () => {
    const p = goodPlan(); p.legal = [{ text: HY, forVoiceoverBlock: 1 }]
    const first = validateTvcPlan(p).plan
    first.voiceover[0].startSeconds = 3
    expect(validateTvcPlan(first).plan.legal[0]).toMatchObject({ startSeconds: 3, endSeconds: 11 })
  })
  it('counts the shot text on screen during it', () => {
    const p = goodPlan(); p.shots[3].text = 'Soft for hours'; p.legal = [{ text: SHORT, startSeconds: 4 }]
    expect(validateTvcPlan(p).plan.legal[0]).toMatchObject({ startSeconds: 4, endSeconds: 9.4 })  // 7 + 2 + 3 words = 12: 12/5 + 3
    const q = goodPlan(); delete q.shots[2].text; q.legal = [{ text: SHORT, startSeconds: 4 }]
    expect(validateTvcPlan(q).plan.legal[0]).toMatchObject({ endSeconds: 8 })
  })
  it('does not count the brand name in the tagline', () => {
    const p = goodPlan(); p.brief.brandName = 'Hya'; p.packshot.tagline = 'Hya. Soft all day, every day, for you'
    p.legal = [{ text: SHORT, startSeconds: 11 }]
    // 7 own + 7 tagline words (Hya not counted) = 14: 14/5 + 3 = 5.8, ends 16.8 > 15
    expect(validateTvcPlan(p).errors.join(' ')).toMatch(/needs 5\.8s/)
  })
  it('LEGAL_HOLD_TOO_LONG names both fixes (E3); wholeAd keeps it on from 0 to the end', () => {
    const p = goodPlan(); p.legal = [{ text: HY, startSeconds: 9 }]
    expect(validateTvcPlan(p).errors).toContain(`LEGAL_HOLD_TOO_LONG: "${HY}" needs 8s on screen; start it earlier, shorten it, or keep it on for the whole ad`)
    const q = goodPlan(); q.legal = [{ text: HY, wholeAd: true }]
    const r = validateTvcPlan(q)
    expect(r.errors).toEqual([])
    expect(r.plan.legal[0]).toMatchObject({ startSeconds: 0, endSeconds: 15 })
  })
  it('LEGAL_TOO_LONG at plan time, before anything is paid', () => {
    const p = goodPlan(); p.legal = [{ text: LONG_9_16, startSeconds: 0 }]
    expect(validateTvcPlan(p).errors).toContain('LEGAL_TOO_LONG: the disclaimer "Based on an independent lab test…" needs 3 lines; ASCI allows 2. Shorten it')
  })
  it('LEGAL_CLAIM_MISSING for a block that does not exist (E7)', () => {
    const p = goodPlan(); p.legal = [{ text: SHORT, forVoiceoverBlock: 3 }]
    expect(validateTvcPlan(p).errors).toContain(`LEGAL_CLAIM_MISSING: legal line "${SHORT}" points at voiceover block 3, which doesn't exist`)
  })
  it('LEGAL_START_MISSING when there is no block, start or wholeAd', () => {
    const p = goodPlan(); p.legal = [{ text: SHORT }]
    expect(validateTvcPlan(p).errors.join(' ')).toMatch(/^LEGAL_START_MISSING/)
  })
  it('two claims in one block overlap and the error suggests combining them (E6)', () => {
    const p = goodPlan(); p.legal = [{ text: SHORT, forVoiceoverBlock: 1 }, { text: 'T&C apply.', forVoiceoverBlock: 1 }]
    const msg = validateTvcPlan(p).errors.join(' ')
    expect(msg).toMatch(/^LEGAL_OVERLAP: only one disclaimer on screen at a time/)
    expect(msg).toMatch(/combine them into one disclaimer \(at most 2 lines\) or move the second claim to its own voiceover block/)
  })
  it('lines linked to the same claim may share the screen', () => {
    const p = goodPlan(); p.legal = [{ text: SHORT, startSeconds: 2, linkedWith: 'spf' }, { text: 'T&C apply.', startSeconds: 3, linkedWith: 'spf' }]
    expect(validateTvcPlan(p).errors).toEqual([])
  })
  it('an auto-added "Creative visualisation" that collides says how to place it yourself', () => {
    const p = goodPlan(); p.brief.market = 'india'; p.shots[2].type = 'mechanism'; p.legal = [{ text: HY, forVoiceoverBlock: 1 }]
    expect(validateTvcPlan(p).errors.join(' ')).toMatch(/add "Creative visualisation" yourself as a legal line with a startSeconds that does not overlap/)
  })
  it('an old saved legal line ({ text, startSeconds } only) still validates and slices (Review Focus 3)', () => {
    const old = tvcPlanSchema.parse({ ...goodPlan(), legal: [{ text: 'Creative visualisation', startSeconds: 4 }] })
    expect(validateTvcPlan(old).errors).toEqual([])
    expect((sliceTvcPlan(old, 'finish') as { legal: unknown }).legal).toEqual([{ text: 'Creative visualisation', startSeconds: 4, endSeconds: 8, style: 'legal' }])
  })
  it('legalTimings returns null for a line it could not place', () => {
    const p = goodPlan(); p.legal = [{ text: SHORT, forVoiceoverBlock: 9 }]
    expect(legalTimings(p).timings).toEqual([null])
  })
})

describe('the finish slice and its order (L4, E4)', () => {
  it('passes each legal line with its computed times and the legal style, and the finish order', () => {
    const p = goodPlan(); p.legal = [{ text: HY, forVoiceoverBlock: 1 }]
    const slice = sliceTvcPlan(validateTvcPlan(p).plan, 'finish') as { legal: unknown; finishOrder: string[] }
    expect(slice.legal).toEqual([{ text: HY, startSeconds: 2, endSeconds: 10, style: 'legal' }])
    expect(slice.finishOrder).toEqual(['composite_end_card', 'assemble_clips', 'mix_voiceover', 'overlay_text', 'mix_music_bed'])
    expect(slice.finishOrder.indexOf('composite_end_card')).toBeLessThan(slice.finishOrder.indexOf('overlay_text'))
  })
  it('skips mix_voiceover in the order when there is no voiceover and no jingle', () => {
    const p = goodPlan(); p.voiceover = []
    expect(finishOrder(p)).toEqual(['composite_end_card', 'assemble_clips', 'overlay_text', 'mix_music_bed'])
  })
})

describe('veg mark wording (L5)', () => {
  it('says recommended, never required', () => {
    const p = goodPlan(); p.brief.market = 'india'; p.brief.category = 'food'
    const w = validateTvcPlan(p).warnings.join(' ')
    expect(w).toMatch(/veg mark is recommended for food and drink \(an FSSAI packaging rule; common practice in TV ads\)/)
    expect(w).not.toMatch(/required/)
  })
})
```

In `planTvc.test.ts`, append:

```ts
describe('runPlanTvc check — disclaimers', () => {
  const TWO_LINES = 'Based on an independent lab test of moisture retention over eight hours. Results may vary.'
  it('refuses a 6 s ad whose 2-line disclaimer needs 8 s, and saves nothing (E3)', async () => {
    const { deps, store } = fakeDeps()
    const p = plan(); p.legal = [{ text: TWO_LINES, startSeconds: 0 }]
    const out = await runPlanTvc({ action: 'check', plan: p }, deps)
    expect(out.errors?.join(' ')).toMatch(/^LEGAL_HOLD_TOO_LONG: .* needs 8s on screen/)
    expect(store.size).toBe(0)
  })
  it('saves wholeAd with the computed times', async () => {
    const { deps, store } = fakeDeps()
    const p = plan(); p.legal = [{ text: TWO_LINES, wholeAd: true }]
    const out = await runPlanTvc({ action: 'check', plan: p }, deps)
    expect(out.errors).toEqual([])
    expect(store.get(out.planFileId!)!.plan.legal[0]).toMatchObject({ startSeconds: 0, endSeconds: 6 })
  })
})
```

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/tvcPlan.test.ts src/mastra/tools/planTvc.test.ts`
Expected: FAIL. `legalTimings` and `finishOrder` are not exported, and the schema strips `forVoiceoverBlock`.

- [ ] **Step 2: Implement in `tvcPlan.ts`**

Import, and re-export the hold (replace the old `legalHoldSeconds` const at line 153):

```ts
import { LEGAL_MAX_LINES, countLegalWords, firstWords, legalHoldSeconds, legalLineCount, nominalFrame } from './legalText.js'
export { legalHoldSeconds }
```

Constants (next to `EPS`): `const MAX_OVERLAYS = 12`

Schema. Add this to `brief`, after `actorLook`:

```ts
    brandName: z.string().optional().describe('The brand name as it appears on screen; not counted in a disclaimer\'s hold time'),
```

Replace the `legal:` line:

```ts
export const legalLineSchema = z.object({
  text: z.string().min(1).describe('The disclaimer, exactly as it should read'),
  forVoiceoverBlock: z.number().int().min(1).optional().describe('The voiceover block that makes the claim (1 = the first block). plan_tvc sets the start to that block\'s start'),
  startSeconds: z.number().min(0).optional().describe('Only for a claim made on screen with no voiceover block: when the disclaimer appears'),
  wholeAd: z.boolean().optional().describe('Keep it on screen for the whole ad, from 0 to the end'),
  linkedWith: z.string().optional().describe('Rare: the same label on disclaimers of one interlinked claim; only those may share the screen'),
  endSeconds: z.number().min(0).optional().describe('Set by plan_tvc check from the ASCI hold rule; never write it'),
})
```

In `tvcPlanSchema`: `legal: z.array(legalLineSchema).default([]),`. `legalLineSchema` must be declared above `tvcPlanSchema`.

New functions (after `legalHoldSeconds`'s old spot):

```ts
export interface LegalTiming { text: string; startSeconds: number; endSeconds: number; lines: number }

/** L2/L3: every disclaimer's start and hold, computed (never chosen by Director). */
export function legalTimings(plan: TvcPlan): { timings: Array<LegalTiming | null>; errors: string[] } {
  const errors: string[] = []
  const length = plan.brief.lengthSeconds
  const frame = nominalFrame(plan.brief.aspectRatio)
  const brandName = plan.brief.brandName
  const starts = shotStarts(plan)
  // Other words on screen while [a, b) is showing: shot texts and the packshot tagline.
  const otherWords = (a: number, b: number): number => plan.shots.reduce((n, s, i) => {
    if (!(starts[i] < b - EPS && starts[i] + s.durationSeconds > a + EPS)) return n
    const shotText = s.text ? countLegalWords(s.text, brandName) : 0
    const tagline = s.type === 'packshot' && plan.packshot.tagline ? countLegalWords(plan.packshot.tagline, brandName) : 0
    return n + shotText + tagline
  }, 0)
  if (plan.legal.length > MAX_OVERLAYS) errors.push(`there are ${plan.legal.length} legal lines; overlay_text takes at most ${MAX_OVERLAYS} overlays`)
  const timings = plan.legal.map((l): LegalTiming | null => {
    const lines = legalLineCount(l.text, frame)
    if (lines > LEGAL_MAX_LINES) {
      errors.push(`LEGAL_TOO_LONG: the disclaimer "${firstWords(l.text)}" needs ${lines} lines; ASCI allows 2. Shorten it`)
      return null
    }
    if (l.wholeAd) return { text: l.text, startSeconds: 0, endSeconds: length, lines }
    let start: number
    if (l.forVoiceoverBlock !== undefined) {
      const block = plan.voiceover[l.forVoiceoverBlock - 1]
      if (!block) {
        errors.push(`LEGAL_CLAIM_MISSING: legal line "${l.text}" points at voiceover block ${l.forVoiceoverBlock}, which doesn't exist`)
        return null
      }
      start = block.startSeconds
    } else if (l.startSeconds !== undefined) {
      start = l.startSeconds
    } else {
      errors.push(`LEGAL_START_MISSING: legal line "${l.text}" needs forVoiceoverBlock (the voiceover block that makes the claim), startSeconds (an on-screen-only claim) or wholeAd`)
      return null
    }
    // The hold counts the words on screen during it, and the window depends on
    // the hold: grow both until they agree (monotone, so this settles).
    let others = 0
    let hold = legalHoldSeconds(l.text, 0, { lines, brandName })
    for (let k = 0; k < 50; k++) {
      const next = otherWords(start, start + hold)
      if (next === others) break
      others = next
      hold = legalHoldSeconds(l.text, others, { lines, brandName })
    }
    const end = r2(start + hold)
    if (end > length + EPS) errors.push(`LEGAL_HOLD_TOO_LONG: "${l.text}" needs ${hold}s on screen; start it earlier, shorten it, or keep it on for the whole ad`)
    return { text: l.text, startSeconds: start, endSeconds: end, lines }
  })
  // L3/E6: one disclaimer on screen at a time, unless linked to the same claim.
  const placed = timings.flatMap((t, i) => (t ? [{ ...t, i }] : [])).sort((a, b) => a.startSeconds - b.startSeconds)
  for (let x = 0; x < placed.length; x++) {
    for (let y = x + 1; y < placed.length; y++) {
      const a = placed[x], b = placed[y]
      if (!(b.startSeconds < a.endSeconds - EPS && a.startSeconds < b.endSeconds - EPS)) continue
      const la = plan.legal[a.i], lb = plan.legal[b.i]
      if (la.linkedWith && la.linkedWith === lb.linkedWith) continue
      let fix = '; start the second after the first ends'
      if (la.forVoiceoverBlock !== undefined && la.forVoiceoverBlock === lb.forVoiceoverBlock) {
        fix = `; both explain voiceover block ${la.forVoiceoverBlock}: combine them into one disclaimer (at most 2 lines) or move the second claim to its own voiceover block`
      } else if ([la.text, lb.text].some((t) => t.toLowerCase() === VISUALISATION.toLowerCase())) {
        fix = `; "${VISUALISATION}" is added for a mechanism or superpower shot: add "${VISUALISATION}" yourself as a legal line with a startSeconds that does not overlap`
      }
      errors.push(`LEGAL_OVERLAP: only one disclaimer on screen at a time ("${firstWords(a.text)}" ${a.startSeconds}–${a.endSeconds}s and "${firstWords(b.text)}" from ${b.startSeconds}s)${fix}`)
    }
  }
  return { timings, errors }
}

/** E4: the end card is laid first and the text last, so a disclaimer is always the top layer. */
export function finishOrder(plan: TvcPlan): string[] {
  const order = ['composite_end_card', 'assemble_clips']
  if (plan.voiceover.length > 0 || plan.brief.jingle) order.push('mix_voiceover')
  order.push('overlay_text', 'mix_music_bed')
  return order
}
```

`VISUALISATION` is declared at line 167, below where these functions go. Move the `const VISUALISATION = 'Creative visualisation'` line up above `legalTimings`.

In `validateTvcPlan`:
- Replace the veg warning with:
  `warnings.push('the veg mark is recommended for food and drink (an FSSAI packaging rule; common practice in TV ads) but cannot be added yet; tell the user')`
- Replace the whole `plan.legal.forEach((l) => { const hold = legalHoldSeconds(l.text) ... })` block (the old hold **warning**) with:

```ts
  // L2/L3: the hold is an error now, and the plan stores the computed times.
  const legal = legalTimings(plan)
  errors.push(...legal.errors)
  legal.timings.forEach((t, i) => {
    if (!t) return
    plan.legal[i].startSeconds = t.startSeconds
    plan.legal[i].endSeconds = t.endSeconds
  })
```

In `sliceTvcPlan`'s `finish` branch:
- Replace `legal: plan.legal,` with:
  `legal: legalTimings(plan).timings.flatMap((t) => (t ? [{ text: t.text, startSeconds: t.startSeconds, endSeconds: t.endSeconds, style: 'legal' as const }] : [])),`
- Add as the **last** spread in the returned object:
  `...(plan.legal.length > 0 ? { finishOrder: finishOrder(plan) } : {}),`

In `planTvc.ts`, append this to the end of the tool `description` string:
`' check also works out every disclaimer\'s start (from the voiceover block that makes the claim) and its ASCI hold, and refuses LEGAL_TOO_LONG, LEGAL_HOLD_TOO_LONG, LEGAL_OVERLAP or LEGAL_CLAIM_MISSING; the finish slice lists the legal lines with their times and the finish order.'`

- [ ] **Step 3: Run the tests and check that they pass**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/tvcPlan.test.ts src/mastra/tools/planTvc.test.ts src/mastra/tools/legalText.test.ts && pnpm --filter agent-orchestrator type-check`
Expected: PASS. "A plan without a jingle slices and prices exactly as before" and "lengthSeconds reaches Gemini without a numeric enum" must pass unchanged. The first proves that a plan with no legal lines has no `finishOrder` key. The second proves that `forVoiceoverBlock` added no numeric literal.

- [ ] **Step 4: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts apps/agent-orchestrator/src/mastra/tools/tvcPlan.test.ts apps/agent-orchestrator/src/mastra/tools/planTvc.ts apps/agent-orchestrator/src/mastra/tools/planTvc.test.ts
git commit -m "feat(tvc-plan): disclaimers synced to their claim, ASCI hold computed, one per frame

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: the end card never covers a disclaimer (E4)

**How the order is enforced today:** only by prose. `director.md`'s finish step lists `composite_end_card` on the packshot clip (line 31) before `overlay_text` (line 34). Nothing in code stops the reverse.

**What this plan puts in code:**
1. The finish slice's `finishOrder` (Task 3).
2. This task: `composite_end_card` refuses before any charge when its input video was produced by a legal `overlay_text`. That is detectable from the storage key's `legal-text` marker (Task 2). This is the same pattern as `extract_frame`'s key marker, which `plan_tvc` reads.

**Limit, stated plainly:** if the disclaimer video was re-processed by another tool first (for example `mix_music_bed` writes a new file without the marker), the marker is gone and this check cannot see it. `finishOrder` still governs that case. No plan-time "legal over packshot" refusal is added, because the order is fixed by the slice.

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/compositeEndCard.ts`
- Test: `apps/agent-orchestrator/src/mastra/tools/compositeEndCard.test.ts`

**Interfaces:**
- Consumes (Task 1): `carriesLegalTextPath(urlOrKey: string): boolean`.
- Produces: refusal reason `END_CARD_OVER_DISCLAIMER: this video already carries its disclaimer, and the end card would cover it. Lay the end card on the packshot clip first and run overlay_text last (the finish slice's finishOrder)`.

- [ ] **Step 1: Write the failing test** (append to `compositeEndCard.test.ts`; it reuses the file's hoisted mocks)

```ts
describe('the end card never covers a disclaimer (E4)', () => {
  beforeEach(() => { vi.clearAllMocks() })
  const run = async () => {
    const { compositeEndCard } = await import('./compositeEndCard.js')
    const rc = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })) rc.set(k, v)
    return compositeEndCard.execute!({ videoFileId: 'v1', productPhotoFileId: 'p1', aspectRatio: '16:9' } as never, { requestContext: rc, agent: { toolCallId: 'call-1' } } as never)
  }
  it('refuses END_CARD_OVER_DISCLAIMER before any charge, download or ffmpeg', async () => {
    isUnlimited.mockResolvedValue(false)
    resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 1_000 } })
    fetchPresignedUrl.mockImplementation(async (fileId: string) => (fileId === 'v1'
      ? 'https://cdn.example/generated/c1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-legal-text-video-with-text-overlay.mp4?X-Amz-Signature=x'
      : `https://cdn.example/${fileId}`))
    const result = await run()
    expect(result).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^END_CARD_OVER_DISCLAIMER: /) })
    expect(spendCredits).not.toHaveBeenCalled()
    expect(downloadToSessionCache).not.toHaveBeenCalled()
    expect(execFile).not.toHaveBeenCalled()
  })
  it('does not refuse a packshot clip with no disclaimer', async () => {
    isUnlimited.mockResolvedValue(true)
    fetchPresignedUrl.mockImplementation(async (fileId: string) => `https://cdn.example/generated/c1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-${fileId}.mp4`)
    downloadToSessionCache.mockRejectedValue(new Error('stop here'))
    expect(await run()).toMatchObject({ refused: true, refusalReason: 'SOURCE_UNAVAILABLE' })
    expect(downloadToSessionCache).toHaveBeenCalled()
  })
})
```

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/compositeEndCard.test.ts`
Expected: FAIL in the first test. It gets `SOURCE_UNAVAILABLE` or a charge instead of the refusal.

- [ ] **Step 2: Implement**

In `compositeEndCard.ts`, import `carriesLegalTextPath` and declare the reason:

```ts
import { carriesLegalTextPath } from './legalText.js'

const END_CARD_OVER_DISCLAIMER = 'END_CARD_OVER_DISCLAIMER: this video already carries its disclaimer, and the end card would cover it. Lay the end card on the packshot clip first and run overlay_text last (the finish slice\'s finishOrder)'
```

Inside the download `try`, insert this between the URL `Promise.all` and the download `Promise.all`:

```ts
      // E4: overlay_text marks the key of every video it burned a disclaimer
      // into; an end card laid over it would hide the disclaimer. Refused
      // before the charge, so this costs nothing.
      if (carriesLegalTextPath(videoUrl)) return { refused: true, refusalReason: END_CARD_OVER_DISCLAIMER, jobId }
```

Append to the tool `description` string: `' Never run it on a video that already carries a disclaimer from overlay_text (refused with END_CARD_OVER_DISCLAIMER); in the TVC finish the end card always comes first.'`

- [ ] **Step 3: Run the tests and check that they pass**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/compositeEndCard.test.ts src/mastra/tools/legalText.test.ts && pnpm --filter agent-orchestrator type-check`
Expected: PASS, with every existing `compositeEndCard` test unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/compositeEndCard.ts apps/agent-orchestrator/src/mastra/tools/compositeEndCard.test.ts
git commit -m "feat(end-card): refuse to cover a burned-in disclaimer (E4)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: real ffmpeg proves the size and the Devanagari font, and the VM gets the fonts

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/overlayText.realffmpeg.test.ts`
- Modify: `deploy-orch.sh`

**Interfaces:**
- Consumes: `overlayText`, `buildAss` (Task 2), `wrapLegal`, `legalLineCount` and `nominalFrame` (Task 1).
- Produces: nothing used by code. It is the measured proof of `LEGAL_FONT_HEIGHT_PER_EM`.

**Local Mac note:** the Homebrew core `ffmpeg` on this machine has **no `subtitles` filter (no libass)**, and Noto Sans Devanagari is not installed. With `RUN_REAL_FFMPEG=1` the suite then skips and prints what to install. The VM (Debian, `ffmpeg` with libass) is the place this test is expected to run. See Deploy step 2.

- [ ] **Step 1: Write the tagged test**

```ts
// Real ffmpeg + libass + fontconfig, not mocked. Tagged: runs only with RUN_REAL_FFMPEG=1.
// Without libass or the Noto fonts it skips and says how to install them.
import { describe, it, expect, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RequestContext } from '@mastra/core/request-context'

vi.mock('@serverless-saas/credits', () => ({ spendCredits: vi.fn(), resolveRate: vi.fn(async () => null), isUnlimited: vi.fn(async () => true), costMicro: () => 0n }))
vi.mock('../../usage.js', () => ({ getPool: vi.fn() }))
const uploaded: Buffer[] = []
vi.mock('../../persistence.js', () => ({
  uploadGeneratedFile: vi.fn(async (_t: string, i: { content: Buffer }) => { uploaded.push(i.content); return { fileId: 'out', name: 'o.mp4', type: 'video/mp4', size: i.content.length } }),
  uploadFileWithKey: vi.fn(async (_t: string, i: { content: Buffer }) => { uploaded.push(i.content); return { fileId: 'out', name: 'o.mp4', type: 'video/mp4', size: i.content.length } }),
  generatedFileKey: (c: string, t: string, e: string) => `generated/${c}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-${t.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${e}`,
}))
const dir = mkdtempSync(join(tmpdir(), 'legal-real-'))
vi.mock('./mediaCache.js', () => ({
  fetchPresignedUrl: vi.fn(async (id: string) => id),
  downloadToSessionCache: vi.fn(async (_s: string, id: string) => ({ filePath: join(dir, `${id}.mp4`) })),
}))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval: vi.fn(async () => false) }))

import { overlayText, buildAss } from './overlayText.js'
import { legalLineCount, nominalFrame } from './legalText.js'

const FONT_HELP = 'Install the disclaimer fonts. Mac: brew install --cask font-noto-sans font-noto-sans-devanagari. Debian/Ubuntu (the VM): sudo apt-get install -y fonts-noto-core && fc-cache -f'
const LIBASS_HELP = 'This ffmpeg has no subtitles filter (libass). Run on the VM, or on a Mac: brew tap homebrew-ffmpeg/ffmpeg && brew install homebrew-ffmpeg/ffmpeg/ffmpeg'

function whyNot(): string | null {
  if (!process.env.RUN_REAL_FFMPEG) return null
  const filters = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' })
  if (filters.error) return 'ffmpeg is not installed'
  if (!/\bsubtitles\b/.test(filters.stdout)) return LIBASS_HELP
  const fonts = spawnSync('fc-list', [':', 'family'], { encoding: 'utf8' })
  if (fonts.error) return `fc-list (fontconfig) is not installed. ${FONT_HELP}`
  const families = fonts.stdout.split('\n').flatMap((l) => l.split(',').map((f) => f.trim()))
  if (!families.includes('Noto Sans') || !families.includes('Noto Sans Devanagari')) return FONT_HELP
  return null
}
const why = whyNot()
if (why) console.warn(`[overlayText.realffmpeg] SKIPPED: ${why}`)

// Only x-height letters (no ascenders, descenders or dots), so each text band's height IS the x-height.
const X_TEXT = 'our new cream evens rare scars so an owner can wear more mascara as summer comes even nervous users are serene'
const HINDI = 'शर्तें लागू। परिणाम व्यक्ति के अनुसार अलग हो सकते हैं।'
const W = 1920, H = 1080

function grayFrame(video: string, at: number): Buffer {
  return execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(at), '-i', video, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 })
}

/** Box rows: more than 10% of the row is black. Text bands: runs of box rows with bright (white) pixels. */
function measure(gray: Buffer) {
  const boxRows: number[] = []
  const textRows: number[] = []
  for (let y = 0; y < H; y++) {
    let dark = 0, bright = 0
    for (let x = 0; x < W; x++) { const v = gray[y * W + x]; if (v < 40) dark++; else if (v > 180) bright++ }
    if (dark > W * 0.1) { boxRows.push(y); if (bright > 0) textRows.push(y) }
  }
  const bands: Array<{ top: number; height: number }> = []
  for (const y of textRows) {
    const last = bands[bands.length - 1]
    if (last && y === last.top + last.height) last.height++
    else bands.push({ top: y, height: 1 })
  }
  return { boxTop: boxRows[0], boxBottom: boxRows[boxRows.length - 1], bands }
}

function grayClip(name: string): string {
  const path = join(dir, `${name}.mp4`)
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x808080:s=${W}x${H}:d=3:r=25`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path])
  return path
}

describe.skipIf(!process.env.RUN_REAL_FFMPEG || !!why)('overlay_text legal style against real ffmpeg + libass', () => {
  it('burns a 2-line disclaimer at 1920x1080 with an x-height of at least 26 px, in one box inside the frame', async () => {
    expect(legalLineCount(X_TEXT, nominalFrame('16:9'))).toBe(2)
    grayClip('src')
    const rc = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't', conversationId: 'c', idToken: 'tok' })) rc.set(k, v)
    const result = await overlayText.execute!({ videoFileId: 'src', overlays: [{ text: X_TEXT, startSeconds: 0, endSeconds: 3, position: 'bottom', size: 'legal' }] } as never, { requestContext: rc, agent: { toolCallId: 'x' } } as never)
    expect(result).toMatchObject({ fileId: 'out', positions: ['bottom'] })
    const out = join(dir, 'legal.mp4'); writeFileSync(out, uploaded[uploaded.length - 1])
    const m = measure(grayFrame(out, 1.5))
    console.log('[overlayText.realffmpeg] measured', JSON.stringify(m))
    expect(m.bands).toHaveLength(2)                         // libass drew exactly our 2 lines
    for (const band of m.bands) expect(band.height).toBeGreaterThanOrEqual(26)
    expect(m.boxTop).toBeLessThan(m.bands[0].top)
    expect(m.boxBottom).toBeGreaterThan(m.bands[1].top + m.bands[1].height)
    expect(m.boxBottom).toBeLessThanOrEqual(H - 60)          // inside the bottom safe margin
  }, 120_000)

  it('renders a Hindi disclaimer with no missing glyphs (no tofu)', () => {
    const src = grayClip('src-hi')
    const ass = join(dir, 'hindi.ass')
    writeFileSync(ass, buildAss([{ text: HINDI, startSeconds: 0, endSeconds: 3, position: 'bottom', size: 'legal' }], { width: W, height: H }))
    const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'verbose', '-ss', '1.5', '-i', src, '-vf', `subtitles=${ass}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 })
    const stderr = run.stderr.toString()
    expect(run.status).toBe(0)
    expect(stderr).not.toMatch(/failed to find any fallback/i)
    const m = measure(run.stdout)
    expect(m.bands.length).toBeGreaterThanOrEqual(1)
    const bright = [...run.stdout].filter((v) => v > 180).length
    expect(bright).toBeGreaterThan(2000)                     // real glyphs were drawn
  }, 120_000)
})
```

- [ ] **Step 2: Run it untagged, then tagged**

Run: `pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/overlayText.realffmpeg.test.ts`
Expected: the suite is skipped (no variable).

Run: `RUN_REAL_FFMPEG=1 pnpm --filter agent-orchestrator exec vitest run src/mastra/tools/overlayText.realffmpeg.test.ts`
Expected on this Mac: skipped, with `[overlayText.realffmpeg] SKIPPED: This ffmpeg has no subtitles filter (libass)…` printed.
Expected where libass and the fonts exist: PASS, with the measured band heights printed.

If a band measures under 26 px:
- Raise `LEGAL_FONT_HEIGHT_PER_EM` in `legalText.ts` by the measured shortfall ratio (for example, 24 measured → × 26/24).
- Update the Task 1 and Task 2 size expectations (`122`, `69`) to match.
- Re-run. Never lower the 26 px bar.

- [ ] **Step 3: Make the VM deploy install the fonts**

In `deploy-orch.sh`, insert this before `echo "→ Seeding Official skills..."`:

```bash
# TVC disclaimers (overlay_text size "legal") render in Noto Sans, with Noto
# Sans Devanagari as the fontconfig fallback; without them a Hindi disclaimer
# renders as empty boxes. fonts-noto-core ships both. Idempotent.
echo "→ Checking disclaimer fonts..."
if ! fc-list : family | grep -q "Noto Sans Devanagari"; then
  echo "  installing fonts-noto-core..."
  if ! (sudo -n apt-get update -qq && sudo -n apt-get install -y -qq fonts-noto-core); then
    echo "✗ fonts-noto-core is missing and could not be installed without a password. Run: sudo apt-get install -y fonts-noto-core && fc-cache -f"
    exit 1
  fi
  fc-cache -f
fi
```

Run: `bash -n deploy-orch.sh`
Expected: no output (the syntax is valid).

- [ ] **Step 4: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/overlayText.realffmpeg.test.ts deploy-orch.sh
git commit -m "test(overlay-text): measure the legal x-height and Devanagari glyphs on real ffmpeg; VM installs Noto

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: the skill text (L4, L5), append only

**Files:**
- Modify (append only): `products/agent-platform/packages/api/seeds/official-skills/tvc-ad/director.md`
- Modify (append only): `products/agent-platform/packages/api/seeds/official-skills/tvc-ad.md`
- Test: `products/agent-platform/packages/api/__tests__/officialSkillsSeed.test.ts`

**Interfaces:**
- Consumes the names that Tasks 2–4 put in front of Director: `size "legal"`, `forVoiceoverBlock`, `wholeAd`, `brief.brandName`, `finishOrder`, and the reasons `LEGAL_TOO_LONG`, `LEGAL_HOLD_TOO_LONG`, `LEGAL_OVERLAP`, `LEGAL_CLAIM_MISSING` and `END_CARD_OVER_DISCLAIMER`.
- Produces: nothing in code.

- [ ] **Step 1: Write the failing test**

Add these lines at the end of the `'tvc-ad follows the final-review rulings'` test, before its closing `});`:

```ts
    // Part 2.1: legal disclaimers (additive section).
    expect(director).toMatch(/Legal disclaimers \(supersede the legal parts of the lines above\)/)
    expect(director).toMatch(/forVoiceoverBlock = the number of the voiceover block that makes the claim/)
    expect(director).toMatch(/Never write endSeconds/)
    expect(director).toMatch(/brief\.brandName/)
    expect(director).toMatch(/run the steps in the finish slice's finishOrder; composite_end_card always comes before overlay_text/)
    expect(director).toMatch(/pass each of the finish slice's legal entries exactly as given \(text, startSeconds, endSeconds\) with size "legal"/)
    expect(director).toMatch(/Never shorten or move a disclaimer to make it fit/)
    expect(director).toMatch(/On LEGAL_TOO_LONG or LEGAL_HOLD_TOO_LONG, return the reason to Olmo/)
    expect(director).toContain('END_CARD_OVER_DISCLAIMER')
    expect(director).toMatch(/does not make a performance claim acceptable/)
    // The shipped lines are still there, word for word (append only).
    expect(director).toMatch(/position bottom, size small/)
    expect(card).toMatch(/16\. Disclaimers: when the ad makes a product claim/)
    expect(card).toMatch(/Disclaimer for '<the claim>': <text>/)
    expect(card).not.toMatch(/forVoiceoverBlock|overlay_text|plan_tvc/)
```

Note: the last line forbids those tool names in the user-facing card. The card already names other tools (for example `list_casting_assets`), so the test only bans these three.

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/officialSkillsSeed.test.ts`
Expected: FAIL on the first new expectation.

- [ ] **Step 2: Append to `tvc-ad/director.md`** (after its last line, with one blank line before)

```text

Legal disclaimers (supersede the legal parts of the lines above):
- step plan: for each product claim (a number, a comparison, "clinically", an offer), write one legal line with its disclaimer text and forVoiceoverBlock = the number of the voiceover block that makes the claim (1 = the first block). Give startSeconds only for a claim made on screen with no voiceover, or wholeAd true to keep it on for the whole ad. Never write endSeconds; plan_tvc works out every start and hold. Write brief.brandName.
- One disclaimer per voiceover block. When plan_tvc check returns LEGAL_OVERLAP or LEGAL_CLAIM_MISSING, fix what it says (combine two disclaimers of one block into one of at most 2 lines, move a second claim to its own voiceover block, or point at the right block) and check again.
- Never shorten or move a disclaimer to make it fit. On LEGAL_TOO_LONG or LEGAL_HOLD_TOO_LONG, return the reason to Olmo in plain words.
- step finish: run the steps in the finish slice's finishOrder; composite_end_card always comes before overlay_text, so the disclaimer is the top layer.
- overlay_text: pass each of the finish slice's legal entries exactly as given (text, startSeconds, endSeconds) with size "legal" and position bottom; never change their times. Legal lines count first toward overlay_text's 12 overlays: drop per-shot texts, never a legal line.
- overlay_text refused with LEGAL_TOO_LONG, or composite_end_card refused with END_CARD_OVER_DISCLAIMER: return the reason to Olmo; never make the disclaimer smaller.
- "Creative visualisation" is added for a mechanism or superpower shot as industry practice; it does not make a performance claim acceptable, so a claim still needs its own disclaimer.
```

- [ ] **Step 3: Append to `tvc-ad.md`** (after its last line, with one blank line before)

```text

16. Disclaimers: when the ad makes a product claim (a number, a comparison, "clinically", an offer), ask for its disclaimer or confirm one in plain words, for example "the line about SPF will show the small print 'Based on a lab test. Results may vary.'", and pass it in the "step: plan" delegation as "Disclaimer for '<the claim>': <text>". If Director reports a disclaimer is too long or needs more time on screen than the ad has, tell the user in one plain sentence and offer a shorter disclaimer, an earlier claim, or keeping it on screen for the whole ad. A "Creative visualisation" line does not make a claim acceptable on its own. Never call the ad legally compliant; the final legal sign-off is theirs.
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
git commit -m "feat(tvc-skill): disclaimers tied to their claim, finish order, plain reasons (append only)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Deploy (after merge; done by the user, not by an implementer)

1. **Fonts on the VM:** `./deploy-orch.sh` now checks for them and installs `fonts-noto-core` if missing (Task 5). To check by hand first:

   ```bash
   fc-list : family | grep -E "^Noto Sans(,|$)|Noto Sans Devanagari" | head
   ```

   If it prints nothing, run `sudo apt-get install -y fonts-noto-core && fc-cache -f`.
2. **The real-ffmpeg proof on the VM:**

   ```bash
   cd apps/agent-orchestrator && RUN_REAL_FFMPEG=1 pnpm exec vitest run src/mastra/tools/overlayText.realffmpeg.test.ts
   ```

   It must PASS, not skip, and print band heights of 26 or more.
3. **Orchestrator and the official skills:** `./deploy-orch.sh`. It installs the fonts, seeds the official skills (the `director.md` and `tvc-ad.md` additions), builds and restarts `agent-orchestrator`. Check that the `tvc-ad` skill's latest version contains "Legal disclaimers (supersede".
4. **Web and the skills seed:** `./deploy.sh`. It re-seeds the skills (idempotent) and rebuilds web. Web code is unchanged by this plan.
5. **No migration and no credit-rate change.** `overlay_text` and `composite_end_card` keep their rates.
6. **Live test:** a 15 s India beverage ad, landscape, with one claim in voiceover block 1 ("50% less sugar") and one Hindi disclaimer.
   - The disclaimer appears when that block starts.
   - It sits in a black box at the bottom, in at most 2 lines.
   - It stays on for the computed hold.
   - It is visible over the end card.
   - Its Devanagari has no empty boxes.

   Then ask for a 3-line disclaimer, and confirm that the plan refuses it in plain words before anything is paid.
