# TVC Part 2.3: 30-Second Ads with a Two-Stage Join Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The TVC skill can plan and finish a 30 s ad of up to 20 shots. A plan of more than 12 shots is joined in two stages with the existing `assemble_clips`: each half (at most 12 clips), then the two halves. The plan decides the split in code, so it never separates a continuing shot from the shot it continues.

**Architecture:**
- **The plan rules (`tvcPlan.ts`, J1, E7):**
  - `lengthSeconds` accepts 30. It stays a refined `z.number()`, never a numeric enum.
  - `WORD_CAPS[30] = 45`.
  - `maxShotsFor(length)` returns 20 for 30 s and 12 otherwise. Over the cap the error is `there are N shots; a <len>s ad takes at most M`.
  - A reference with more cuts than the length can hold also gets `REFERENCE_TOO_MANY_CUTS: …`. The existing `the reference has N cuts in Ls; this plan has M` error still fires as before.
- **The split (`joinSplit`, J2, E1):**
  - A pure function on the plan. It returns `null` for 12 shots or fewer, `{ groups }` for two halves, or `{ error: 'JOIN_SPLIT_IMPOSSIBLE: …' }`.
  - `validateTvcPlan` reports that error, so an impossible plan is never saved.
- **The finish slice, the order and the price (J2, J4):**
  - For more than 12 shots, the finish slice adds `finishOrder`, `joinGroups` and `finalJoin: true`.
  - `finishOrder` replaces the single `assemble_clips` with `assemble_clips group 1`, `assemble_clips group 2` and `assemble_clips final`.
  - `tvcCreditSteps` counts one join per group plus the final join.
  - Plans of 12 shots or fewer are byte-identical: the same keys, the same sha256 and the same credit steps.
- **`assemble_clips` is not changed (J3).** Each half is joined with `preserveAudio` and `roomTone` true. The final join passes the two half videos with `preserveAudio` true and `roomTone` false. Its existing per-stage length check, its 40 ms seam fades and its fps handling do the rest. A tagged real-ffmpeg test proves the two stages on 20 tiny 24 fps clips.
- **Skill text (J5):** append-only sections in `tvc-ad/director.md` and `tvc-ad.md`, pinned by `officialSkillsSeed.test.ts`.

**Tech Stack:** TypeScript, zod, vitest, Mastra `createTool`, ffmpeg/ffprobe via `execFile` (no libass needed).

**Spec:** `docs/superpowers/specs/2026-10-10-tvc-30s-two-stage-join-design.md` (J1–J5, E1–E8, §5). Read it before your task. The style precedent is `docs/superpowers/plans/2026-10-09-tvc-text-logo-vegmark.md`; its code is on this branch.

## Global Constraints

- **No numeric enums in tool schemas.** Gemini only accepts string enums. `lengthSeconds` stays `z.number().refine(...)`. The refine message is exactly `lengthSeconds must be 6, 15, 20 or 30`.
- **Plans of 12 shots or fewer are untouched (E6):**
  - The finish slice has the same keys and the same bytes. For `planOf(20, 12)` (Task 1's helper, validated) the sha256 of `JSON.stringify(sliceTvcPlan(plan, 'finish'))` is `2b813d2b4df17d298badaf6ed8baace026d5b52b5998dd7b6ca0bc59dd4ed408`. For `planOf(20, 8)` it is `3f1e82ea1e2dad47c5438b38248aa4efdffe7722c8c1be39efe3703f63764466`.
  - The `shots 1-12` slice of `planOf(20, 12)` hashes to `d48541a023703cd9634db2ab6db1f00c55ee47901549990a736ead0da807faf3`.
  - `tvcCreditSteps` still ends `{ kind: 'edit', count: n + 5 }`.
  - These hashes were measured on origin/main 723ddab0 before this change. If one moves, the code is wrong, not the hash.
- **`assemble_clips` is unchanged.** Do not edit `assembleClips.ts`. The 12-clip cap stays: a 13-clip call is still refused. The final join's `roomTone: false` is something Director passes, not a code change.
- **Additive prompt changes only.** Never delete or reword a shipped line in any skill or agent prompt. Append lines, and edit only `tvc-ad.md` and `tvc-ad/director.md`. `tvc-ad.md` must still not match `/30 are also possible/` or name a tool (`plan_tvc`, `overlay_text`, `composite_end_card`, `forVoiceoverBlock`).
- **Numbers (copied from the spec):**
  - Lengths: 6, 15, 20 and 30.
  - Word caps: 6s 8, 15s 22, 20s 30, 30s 45.
  - Shot caps: 20 for 30 s, otherwise 12. A join takes at most 12 clips.
  - The packshot is 2–4 s, and the other shots are 1.2–2.5 s. The brand and product rules are unchanged.
  - The split goes to the valid boundary nearest the middle by time, and prefers a place change within ±2 shots of that.
  - The length tolerance per join is `0.1 + 0.03 × clips`, unchanged.
- **Plain reasons, verbatim:**
  - `there are ${n} shots; a ${length}s ad takes at most ${max}`
  - `JOIN_SPLIT_IMPOSSIBLE: ${n} shots can't be joined as two halves of at most 12 without separating a shot from the shot that continues it; make one of the continuing shots in the middle of the ad its own shot`
  - `REFERENCE_TOO_MANY_CUTS: the reference has ${c} cuts in ${length}s, so matching it needs ${c + 1} shots; a ${length}s ad takes at most ${max}. Make a shorter cutdown of the reference, or plan a ${length}s ad at our own pace without its cuts`
- **The real-ffmpeg test is tagged `RUN_REAL_FFMPEG=1`.** It needs no libass, so it runs on the local Mac (about 10 s), and the implementer must run it there, not skip it.
- **Commits:** every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Add `docs/**/*.md` and the skill `.md` files with `git add -f` (the repo ignores `*.md`).
- **Where work happens:** the worktree `.claude/worktrees/tvc-30s`, branch `tvc-30s`. Never `git stash`, never push. Before the first test run: `pnpm install && pnpm --filter "agent-orchestrator^..." build`. Run orchestrator tests from `apps/agent-orchestrator` with `pnpm exec vitest run <file>`.

## Review Focus

1. **A 6, 15 or 20 s ad (or any plan of 12 shots or fewer) must not change at all.**
   - Its finish slice must not gain `finishOrder`, `joinGroups` or `finalJoin`.
   - Its credit estimate must not gain two joins.
   - Pinned by sha256 in Task 2 ("E6: 12 shots or fewer are untouched"). The existing finish-order tests in `tvcPlan.test.ts` must pass unedited.
2. **The split never breaks a continuing pair, and an impossible plan is refused, never sliced.**
   - With a continuing shot across the middle boundary, the split moves to the nearest valid boundary.
   - Every legal arrangement of continuing shots at 20 shots still splits. A chain is the only way to block every boundary, and the plan already refuses chains.
   - Pinned in Task 1 (the E1 tests, including the exhaustive one).
3. **Room tone is laid once.** The halves pass `roomTone: true`. The final join passes `roomTone: false`, or the brown noise doubles under the whole ad.
   - Pinned in Task 4 (the director line, by the seed test).
   - Exercised for real in Task 3 (the final join runs with `roomTone: false` and still passes its length check).
4. **Length drift stays caught at every stage, and a 20-clip ad still lands on its length.**
   - AAC padding adds about 0.01–0.03 s per piece, and two stages add one more seam.
   - Task 3 measures it: about 0.21 s over 20 pieces on the reference Mac, against a tolerance of 0.7 s.
   - The final join's own check (2 clips, 0.16 s against the halves' real lengths) must not false-refuse.
   - Director's text says what to do with a `DURATION_MISMATCH` at any stage (Task 4).
5. **A reference ad cut faster than we can match gets a plain answer, and the old message stays.**
   - A 30 s reference with 22 cuts gets `REFERENCE_TOO_MANY_CUTS` in plain words.
   - The existing `the reference has N cuts in Ls; this plan has M` error still fires, because `planTvc.test.ts`'s 13-vs-7 test matches it unedited.
   - Pinned in Task 1 (E7).

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts` (modify) | J1: lengths, word cap, `maxShotsFor`, E7 reason. J2: `joinSplit`, `joinGroupsFor`, `JOIN_STEPS`, the finish slice, `finishOrder`. J4: `tvcCreditSteps` |
| `apps/agent-orchestrator/src/mastra/tools/tvcPlan30s.test.ts` (create) | Unit tests for 30 s rules, the split, the slice, the price, and the legacy pins |
| `apps/agent-orchestrator/src/mastra/tools/tvcPlan.test.ts` (modify) | Two existing tests whose expected behaviour the spec changes (30 is now accepted; the shot-cap message names the length) |
| `apps/agent-orchestrator/src/mastra/tools/planTvc.ts` (modify) | Tool description: one appended sentence about `joinGroups` |
| `apps/agent-orchestrator/src/mastra/tools/planTvc.test.ts` (modify) | Pins that sentence |
| `apps/agent-orchestrator/src/mastra/tools/assembleClips.twoStage.realffmpeg.test.ts` (create) | Tagged: 20 clips joined in two halves, then the halves; fps, length and the seam fade |
| `products/agent-platform/packages/api/seeds/official-skills/tvc-ad/director.md`, `tvc-ad.md` (modify, append only) | J5 |
| `products/agent-platform/packages/api/__tests__/officialSkillsSeed.test.ts` (modify) | Pins the appended lines |

---

### Task 1: 30 s plan rules and where the halves split (J1, J2, E1, E7)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts` (lines 8–10 constants, 82 `lengthSeconds`, 104 `shots` describe, insert before `finishOrder` at 300, 326–327 shot cap, 471–472 reference cuts)
- Modify: `apps/agent-orchestrator/src/mastra/tools/tvcPlan.test.ts:81-87` and `:137-139`
- Create: `apps/agent-orchestrator/src/mastra/tools/tvcPlan30s.test.ts`

**Interfaces:**
- Consumes: `shotStarts(plan)` (existing; `starts[k]` is shot k+1's start, so it is also the time of the boundary after shot k), `TvcPlan`.
- Produces (Task 2 imports these exact names):
  - `MAX_JOIN_CLIPS = 12`, `MAX_SHOTS_30 = 20`, `maxShotsFor(lengthSeconds: number): number`
  - `type JoinSplit = { groups: number[][] } | { error: string }`
  - `joinSplit(plan: TvcPlan): JoinSplit | null` (`null` when 12 shots or fewer)
  - `joinGroupsFor(plan: TvcPlan): number[][] | undefined`
  - `MAX_SHOTS` stays exported and stays 12.

- [ ] **Step 1: Write the failing tests**

Create `apps/agent-orchestrator/src/mastra/tools/tvcPlan30s.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { MAX_JOIN_CLIPS, WORD_CAPS, joinGroupsFor, joinSplit, maxShotsFor, tvcPlanSchema, validateTvcPlan, type TvcPlan } from './tvcPlan.js'

// A valid plan of n shots at `length` seconds: n-1 alternating close-up/wide
// shots at location 0, packshot last, durations summing to `length`.
// Do not change this helper: Task 2's sha256 pins were taken with it.
function planOf(length: number, n: number): TvcPlan {
  const each = Math.min(2.5, Math.floor(((length - 3) / (n - 1)) * 10) / 10)
  const shots = Array.from({ length: n - 1 }, (_, i) => ({
    n: i + 1, type: i === 0 ? 'hook' : 'lifestyle', size: i % 2 === 0 ? 'close_up' : 'wide', action: 'a moment', location: 0,
    durationSeconds: each, brandVisible: i === 0, productVisible: i === 0, audio: 'voiceover',
  }))
  return tvcPlanSchema.parse({
    brief: { message: 'Cold in one sip', category: 'beverage', tier: 'mass', objective: 'brand', market: 'generic', lengthSeconds: length, aspectRatio: '16:9', productPhotoFileId: 'prod' },
    look: 'bright', locations: ['kitchen', 'balcony'],
    shots: [...shots, { n, type: 'packshot', size: (n - 1) % 2 === 0 ? 'close_up' : 'medium', action: 'the can', location: 0, durationSeconds: Math.round((length - each * (n - 1)) * 10) / 10, brandVisible: true, productVisible: true, audio: 'silent' }],
    voiceover: [{ text: 'Cold in one sip.', startSeconds: 3 }], packshot: { kind: 'product' },
  })
}
const groupsOf = (p: TvcPlan) => joinGroupsFor(p)
// Makes each listed shot continue the shot before it.
const cont = (p: TvcPlan, ...continuing: number[]) => { for (const n of continuing) p.shots[n - 1].continuesFrom = n - 1; return p }

describe('J1: 30s plan rules', () => {
  it('accepts 30 and still refuses other lengths, as a plain number', () => {
    expect(tvcPlanSchema.safeParse(planOf(30, 16)).success).toBe(true)
    for (const bad of [10, 25, 31, 60]) {
      const r = tvcPlanSchema.safeParse({ ...planOf(30, 16), brief: { ...planOf(30, 16).brief, lengthSeconds: bad } })
      expect(r.success).toBe(false)
      expect(JSON.stringify(r.error?.issues)).toContain('lengthSeconds must be 6, 15, 20 or 30')
    }
    const json = JSON.stringify(tvcPlanSchema, (_k, v) => (v && typeof v === 'object' && v.typeName === 'ZodLiteral' && typeof v.value === 'number' ? '__NUMERIC_LITERAL__' : v))
    expect(json).not.toContain('__NUMERIC_LITERAL__')
  })
  it('a 30s plan of 13, 16 or 20 shots passes', () => {
    for (const n of [13, 16, 20]) expect(validateTvcPlan(planOf(30, n)).errors).toEqual([])
  })
  it('caps the script at 45 words for 30s', () => {
    expect(WORD_CAPS[30]).toBe(45)
    const p = planOf(30, 16)
    p.voiceover = [{ text: Array.from({ length: 46 }, () => 'cold').join(' '), startSeconds: 0.5 }]
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/the script is 46 words; cap 45 for 30s/)
  })
  it('caps shots at 20 for 30s and 12 otherwise', () => {
    expect([6, 15, 20, 30].map(maxShotsFor)).toEqual([12, 12, 12, 20])
    expect(validateTvcPlan(planOf(30, 21)).errors.join(' | ')).toMatch(/there are 21 shots; a 30s ad takes at most 20/)
    expect(validateTvcPlan(planOf(20, 13)).errors.join(' | ')).toMatch(/there are 13 shots; a 20s ad takes at most 12/)
  })
  it('E7: a reference with more cuts than the length allows is refused in plain words', () => {
    const p = planOf(30, 20)
    p.brief.reference = { cutTimes: Array.from({ length: 22 }, (_, i) => Math.round((i + 1) * 1.3 * 10) / 10) }
    const errors = validateTvcPlan(p).errors.join(' | ')
    expect(errors).toMatch(/REFERENCE_TOO_MANY_CUTS: the reference has 22 cuts in 30s, so matching it needs 23 shots; a 30s ad takes at most 20\. Make a shorter cutdown of the reference, or plan a 30s ad at our own pace without its cuts/)
    expect(errors).toMatch(/the reference has 22 cuts in 30s; this plan has 19/) // the existing reason still fires
    // 19 cuts at the plan's own boundaries (1.4s apart): matched, no reference error.
    p.brief.reference = { cutTimes: Array.from({ length: 19 }, (_, i) => Math.round((i + 1) * 1.4 * 10) / 10) }
    expect(validateTvcPlan(p).errors.join(' | ')).not.toMatch(/reference/)
  })
})

describe('J2: where the halves split', () => {
  it('12 shots or fewer: no split', () => {
    expect(joinSplit(planOf(20, 12))).toBeNull()
    expect(joinGroupsFor(planOf(30, 12))).toBeUndefined()
  })
  it('splits at the boundary nearest half the length by time', () => {
    // 20 shots of 1.4s: the boundary after shot 11 is at 15.4s, nearest 15s.
    expect(groupsOf(planOf(30, 20))).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [12, 13, 14, 15, 16, 17, 18, 19, 20]])
  })
  it('never splits a shot from the shot that continues it (E1)', () => {
    // 13 shots of 2.2s: the boundary after shot 7 (15.4s) is nearest. With
    // shot 8 continuing 7, the boundary after 6 (13.2s) beats after 8 (17.6s).
    expect(groupsOf(planOf(30, 13))).toEqual([[1, 2, 3, 4, 5, 6, 7], [8, 9, 10, 11, 12, 13]])
    expect(groupsOf(cont(planOf(30, 13), 8))).toEqual([[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12, 13]])
  })
  it('prefers a change of place within 2 shots of the middle', () => {
    const p = planOf(30, 20)
    p.shots.forEach((s) => { s.location = s.n <= 9 ? 0 : 1 })
    expect(groupsOf(p)).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]])
    const q = planOf(30, 20)
    q.shots.forEach((s) => { s.location = s.n <= 8 ? 0 : 1 }) // 3 shots from the middle: too far
    expect(groupsOf(q)?.[0]).toHaveLength(11)
    const r = planOf(30, 20)
    r.shots.forEach((s) => { if (s.n >= 10) s.location = 1 })
    r.shots[8].location = undefined // shot 9 has no place, so 9 -> 10 is not a known change
    expect(groupsOf(r)?.[0]).toHaveLength(11)
  })
  it('keeps both halves at 12 or fewer and every shot in order', () => {
    for (let n = 13; n <= 20; n++) {
      const g = groupsOf(planOf(30, n)) as number[][]
      expect(g[0].length).toBeLessThanOrEqual(MAX_JOIN_CLIPS)
      expect(g[1].length).toBeLessThanOrEqual(MAX_JOIN_CLIPS)
      expect([...g[0], ...g[1]]).toEqual(Array.from({ length: n }, (_, i) => i + 1))
    }
  })
  it('E1: at 20 shots a split always exists, for every allowed set of continuing shots', () => {
    // Only boundaries 8..12 keep both halves at 12 or fewer. Chains are
    // refused, so no two neighbouring boundaries can both be blocked.
    const ks = [8, 9, 10, 11, 12]
    for (let mask = 0; mask < 1 << ks.length; mask++) {
      const blocked = ks.filter((_, i) => mask & (1 << i))
      if (blocked.some((k, i) => i > 0 && k - blocked[i - 1] === 1)) continue
      const p = cont(planOf(30, 20), ...blocked.map((k) => k + 1))
      const g = groupsOf(p) as number[][]
      expect(Array.isArray(g)).toBe(true)
      expect(blocked).not.toContain(g[0].length)
      expect(validateTvcPlan(p).errors.join(' | ')).not.toMatch(/JOIN_SPLIT_IMPOSSIBLE/)
    }
  })
  it('JOIN_SPLIT_IMPOSSIBLE when every allowed boundary is inside a continuing pair', () => {
    const p = cont(planOf(30, 20), 9, 10, 11, 12, 13) // a chain: boundaries 8..12 all blocked
    expect(joinSplit(p)).toEqual({ error: expect.stringMatching(/^JOIN_SPLIT_IMPOSSIBLE: 20 shots can't be joined as two halves of at most 12 without separating a shot from the shot that continues it/) })
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/JOIN_SPLIT_IMPOSSIBLE/)
  })
})
```

Then change the two existing tests in `tvcPlan.test.ts` whose expected behaviour the spec changes (nothing else in that file changes).

At lines 81–87, replace:

```ts
  it('lengths are 6, 15 or 20 seconds; 30 is rejected', () => {
    const p = goodPlan() as unknown as { brief: { lengthSeconds: number } }
    p.brief.lengthSeconds = 30
    expect(tvcPlanSchema.safeParse(p).success).toBe(false)
    p.brief.lengthSeconds = 20
    expect(tvcPlanSchema.safeParse(p).success).toBe(true)
  })
```

with:

```ts
  it('lengths are 6, 15, 20 or 30 seconds; 25 is rejected', () => {
    const p = goodPlan() as unknown as { brief: { lengthSeconds: number } }
    p.brief.lengthSeconds = 25
    expect(tvcPlanSchema.safeParse(p).success).toBe(false)
    p.brief.lengthSeconds = 30
    expect(tvcPlanSchema.safeParse(p).success).toBe(true)
    p.brief.lengthSeconds = 20
    expect(tvcPlanSchema.safeParse(p).success).toBe(true)
  })
```

At lines 137–139, replace:

```ts
  it('at most 12 shots (assemble_clips joins at most 12 clips)', () => {
    expect(validateTvcPlan(plan20(13)).errors.join(' | ')).toMatch(/13 shots; at most 12/)
  })
```

with:

```ts
  it('at most 12 shots for 20s (a 30s ad joins in two halves, Part 2.3)', () => {
    expect(validateTvcPlan(plan20(13)).errors.join(' | ')).toMatch(/there are 13 shots; a 20s ad takes at most 12/)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/tvcPlan30s.test.ts src/mastra/tools/tvcPlan.test.ts`
Expected: FAIL. `tvcPlan30s.test.ts` fails to import `MAX_JOIN_CLIPS`, `maxShotsFor`, `joinSplit` and `joinGroupsFor`. The two edited tests in `tvcPlan.test.ts` fail (30 is refused; the old message).

- [ ] **Step 3: Implement the rules in `tvcPlan.ts`**

(a) Lines 8–10. Replace:

```ts
export const WORD_CAPS: Record<number, number> = { 6: 8, 15: 22, 20: 30 }
// assemble_clips joins at most 12 clips, and every shot is one clip.
export const MAX_SHOTS = 12
```

with:

```ts
export const WORD_CAPS: Record<number, number> = { 6: 8, 15: 22, 20: 30, 30: 45 }
// assemble_clips joins at most 12 clips, and every shot is one clip.
export const MAX_SHOTS = 12
// Part 2.3: a 30s ad is joined in two halves of at most 12 clips each, then
// the two halves are joined, so it may have up to 20 shots.
export const MAX_JOIN_CLIPS = 12
export const MAX_SHOTS_30 = 20
export const maxShotsFor = (lengthSeconds: number): number => (lengthSeconds === 30 ? MAX_SHOTS_30 : MAX_SHOTS)
```

(b) Line 82, `lengthSeconds`. It is still a plain number, never a literal union. Replace it with:

```ts
    lengthSeconds: z.number().refine((n) => n === 6 || n === 15 || n === 20 || n === 30, { message: 'lengthSeconds must be 6, 15, 20 or 30' }).describe('6, 15, 20 or 30 seconds; word cap across voiceover and lines: 6s 8, 15s 22, 20s 30, 30s 45'),
```

(c) Line 104. Replace it with:

```ts
  shots: z.array(shotSchema).min(2).describe(`At most ${MAX_SHOTS} shots (${MAX_SHOTS_30} for a 30s ad)`),
```

(d) Insert directly above the `/** E4: the end card is laid first …` comment that precedes `export function finishOrder` (around line 300):

```ts
export type JoinSplit = { groups: number[][] } | { error: string }

/** J2: where a plan of more than 12 shots is joined in two halves. null for
 *  12 shots or fewer (one join, exactly as before). Boundary k means the
 *  first half is shots 1..k. A boundary is valid when both halves have at
 *  most 12 shots and shot k+1 does not continue shot k. The valid boundary
 *  nearest half the ad's length (by time, earlier on a tie) wins, unless a
 *  valid boundary within 2 shots of it changes place (both shots have a
 *  location and they differ); then the nearest such one wins. */
export function joinSplit(plan: TvcPlan): JoinSplit | null {
  const n = plan.shots.length
  if (n <= MAX_JOIN_CLIPS) return null
  const starts = shotStarts(plan)
  const half = plan.brief.lengthSeconds / 2
  const dist = (k: number) => Math.abs(starts[k] - half)
  const nearest = (ks: number[]) => ks.reduce((best, k) => (dist(k) < dist(best) - 1e-9 ? k : best))
  const valid = Array.from({ length: n - 1 }, (_, i) => i + 1)
    .filter((k) => k <= MAX_JOIN_CLIPS && n - k <= MAX_JOIN_CLIPS && plan.shots[k].continuesFrom !== k)
  if (valid.length === 0) {
    return { error: `JOIN_SPLIT_IMPOSSIBLE: ${n} shots can't be joined as two halves of at most ${MAX_JOIN_CLIPS} without separating a shot from the shot that continues it; make one of the continuing shots in the middle of the ad its own shot` }
  }
  const middle = nearest(valid)
  const placeChange = (k: number) => {
    const a = plan.shots[k - 1].location, b = plan.shots[k].location
    return a !== undefined && b !== undefined && a !== b
  }
  const preferred = valid.filter((k) => Math.abs(k - middle) <= 2 && placeChange(k))
  const k = preferred.length ? nearest(preferred) : middle
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
  return { groups: [range(1, k), range(k + 1, n)] }
}

/** The two halves' shot numbers, or undefined when the plan is joined once. */
export function joinGroupsFor(plan: TvcPlan): number[][] | undefined {
  const split = joinSplit(plan)
  return split && 'groups' in split ? split.groups : undefined
}
```

(e) Lines 326–327 in `validateTvcPlan`. Replace:

```ts
  // assemble_clips joins at most 12 clips.
  if (shots.length > MAX_SHOTS) errors.push(`there are ${shots.length} shots; at most ${MAX_SHOTS}`)
```

with:

```ts
  // assemble_clips joins at most 12 clips; a 30s ad joins in two halves (J1, J2).
  const maxShots = maxShotsFor(length)
  if (shots.length > maxShots) {
    errors.push(`there are ${shots.length} shots; a ${length}s ad takes at most ${maxShots}`)
  } else {
    const split = joinSplit(plan)
    if (split && 'error' in split) errors.push(split.error)
  }
```

(f) Directly after the line `const refCuts = (brief.reference?.cutTimes ?? []).filter(...)` (line 472), and before `if (refCuts.length) {`, insert the following. It is additive: the existing mismatch error below it still fires.

```ts
  // E7: a reference with more cuts than this length allows can never be matched.
  if (refCuts.length + 1 > maxShotsFor(length)) {
    errors.push(`REFERENCE_TOO_MANY_CUTS: the reference has ${refCuts.length} cuts in ${length}s, so matching it needs ${refCuts.length + 1} shots; a ${length}s ad takes at most ${maxShotsFor(length)}. Make a shorter cutdown of the reference, or plan a ${length}s ad at our own pace without its cuts`)
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/tvcPlan30s.test.ts src/mastra/tools/tvcPlan.test.ts src/mastra/tools/planTvc.test.ts && pnpm exec tsc --noEmit`
Expected: PASS, with no type errors. `planTvc.test.ts` passes unedited, including the "13-vs-7" reference test. If an unrelated craft rule fires on `planOf(30, n)`, stop and report it: the helper was verified against this exact code, and changing it breaks Task 2's hashes.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts apps/agent-orchestrator/src/mastra/tools/tvcPlan.test.ts apps/agent-orchestrator/src/mastra/tools/tvcPlan30s.test.ts
git commit -m "$(cat <<'EOF'
feat(tvc-plan): 30s ads up to 20 shots, split in code into two joins (J1, J2, E1, E7)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: the finish slice, the finish order and the price for more than 12 shots (J2, J4, E6)

**Files:**
- Modify: `apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts` (`finishOrder` at about line 345 after Task 1, the `'finish'` branch of `sliceTvcPlan`, and `tvcCreditSteps`)
- Modify: `apps/agent-orchestrator/src/mastra/tools/planTvc.ts:385` (description)
- Test: `apps/agent-orchestrator/src/mastra/tools/tvcPlan30s.test.ts`, `apps/agent-orchestrator/src/mastra/tools/planTvc.test.ts`

**Interfaces:**
- Consumes (Task 1): `joinGroupsFor(plan): number[][] | undefined`, `planOf(length, n)` in the test file.
- Produces:
  - `JOIN_STEPS = ['assemble_clips group 1', 'assemble_clips group 2', 'assemble_clips final']` (exported).
  - For more than 12 shots, the finish slice ends with the keys `finishOrder`, then (`endCard` when present), then `joinGroups: number[][]` and `finalJoin: true`.
  - `tvcCreditSteps` edit count is `n + 4 + joins`, where `joins` is 1, or 3 with groups.
  - Task 4's Director text names exactly these keys and step strings.

- [ ] **Step 1: Write the failing tests**

In `tvcPlan30s.test.ts`, replace the import lines at the top with:

```ts
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  JOIN_STEPS, MAX_JOIN_CLIPS, WORD_CAPS, finishOrder, joinGroupsFor, joinSplit, maxShotsFor, sliceTvcPlan, tvcCreditSteps,
  tvcPlanSchema, validateTvcPlan, type TvcPlan,
} from './tvcPlan.js'
```

and append to the end of the file:

```ts
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')

describe('J2, J4: the finish slice, its order and the price for more than 12 shots', () => {
  it('a 20-shot plan carries joinGroups, finalJoin and the joins in the finish order', () => {
    const p = validateTvcPlan(planOf(30, 20)).plan
    const slice = sliceTvcPlan(p, 'finish') as { joinGroups: number[][]; finalJoin: boolean; finishOrder: string[] }
    expect(slice.joinGroups).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [12, 13, 14, 15, 16, 17, 18, 19, 20]])
    expect(slice.finalJoin).toBe(true)
    // The end card is laid on the packshot clip before it is joined; the joins replace the one assemble_clips.
    expect(slice.finishOrder).toEqual(['composite_end_card', ...JOIN_STEPS, 'mix_voiceover', 'mix_music_bed', 'overlay_text'])
    expect(JOIN_STEPS).toEqual(['assemble_clips group 1', 'assemble_clips group 2', 'assemble_clips final'])
    expect(finishOrder(p)).toEqual(slice.finishOrder)
  })
  it('a 13-shot plan carries the same keys, after the existing ones', () => {
    const slice = sliceTvcPlan(validateTvcPlan(planOf(30, 13)).plan, 'finish') as Record<string, unknown>
    expect(Object.keys(slice)).toEqual(['brief', 'shots', 'voiceover', 'packshot', 'legal', 'narrationFileIds', 'songFileId', 'finishOrder', 'joinGroups', 'finalJoin'])
    expect(slice.joinGroups).toEqual([[1, 2, 3, 4, 5, 6, 7], [8, 9, 10, 11, 12, 13]])
  })
  it('prices one join per half plus the final join', () => {
    expect(tvcCreditSteps(planOf(30, 20))).toEqual([
      { kind: 'image', count: 20 }, { kind: 'video', count: 20 }, { kind: 'narration', count: 1 },
      { kind: 'music', count: 1 }, { kind: 'edit', count: 27 },
    ])
    expect(tvcCreditSteps(planOf(30, 12))).toEqual([
      { kind: 'image', count: 12 }, { kind: 'video', count: 12 }, { kind: 'narration', count: 1 },
      { kind: 'music', count: 1 }, { kind: 'edit', count: 17 },
    ])
  })
})

// E6: plans of 12 shots or fewer slice and price byte-identically.
// Hashes measured on origin/main 723ddab0 before this change.
describe('E6: 12 shots or fewer are untouched', () => {
  it('slices byte-identically to before', () => {
    const p12 = validateTvcPlan(planOf(20, 12)).plan
    expect(sha(sliceTvcPlan(p12, 'finish'))).toBe('2b813d2b4df17d298badaf6ed8baace026d5b52b5998dd7b6ca0bc59dd4ed408')
    expect(sha(sliceTvcPlan(p12, 'shots 1-12'))).toBe('d48541a023703cd9634db2ab6db1f00c55ee47901549990a736ead0da807faf3')
    expect(sha(sliceTvcPlan(validateTvcPlan(planOf(20, 8)).plan, 'finish'))).toBe('3f1e82ea1e2dad47c5438b38248aa4efdffe7722c8c1be39efe3703f63764466')
    expect(finishOrder(p12)).toEqual(['composite_end_card', 'assemble_clips', 'mix_voiceover', 'mix_music_bed', 'overlay_text'])
    expect(JSON.stringify(sliceTvcPlan(p12, 'finish'))).not.toMatch(/joinGroups|finalJoin|finishOrder/)
  })
  it('prices the same', () => {
    expect(tvcCreditSteps(planOf(20, 12))).toEqual([
      { kind: 'image', count: 12 }, { kind: 'video', count: 12 }, { kind: 'narration', count: 1 },
      { kind: 'music', count: 1 }, { kind: 'edit', count: 17 },
    ])
    expect(tvcCreditSteps(planOf(20, 8)).at(-1)).toEqual({ kind: 'edit', count: 13 })
  })
})
```

In `planTvc.test.ts`, add a new `describe` at the end of the file. If `planTvc` is not already imported there, add `import { planTvc } from './planTvc.js'` beside the existing `./planTvc.js` import.

```ts
describe('Part 2.3: the tool description names the two-stage join', () => {
  it('tells Director that a 30s finish slice has joinGroups', () => {
    expect(planTvc.description).toMatch(/A 30s plan may have up to 20 shots; when it has more than 12, the finish slice also has joinGroups \(two lists of shot numbers\) and finalJoin true, and finishOrder lists the three joins/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/tvcPlan30s.test.ts src/mastra/tools/planTvc.test.ts`
Expected: FAIL. `JOIN_STEPS` is not exported. The 20-shot slice has no `joinGroups`. The edit count is 25, not 27. The description does not match. The E6 pins already PASS, which is correct: they guard the change.

- [ ] **Step 3: Implement**

(a) In `tvcPlan.ts`, directly after `joinGroupsFor` (added in Task 1), add:

```ts
/** J2: the three joins that replace the single assemble_clips step. */
export const JOIN_STEPS = ['assemble_clips group 1', 'assemble_clips group 2', 'assemble_clips final']
```

(b) In `finishOrder`, replace its first line:

```ts
  const order = ['composite_end_card', 'assemble_clips']
```

with:

```ts
  const order = ['composite_end_card', ...(joinGroupsFor(plan) ? JOIN_STEPS : ['assemble_clips'])]
```

(c) In `sliceTvcPlan`'s `'finish'` branch, after `const endCard = endCardInputs(plan)`, add:

```ts
    const joinGroups = joinGroupsFor(plan)
```

and replace the last two spread lines of the returned object:

```ts
      ...(plan.legal.length > 0 ? { finishOrder: finishOrder(plan) } : {}),
      ...(endCard ? { endCard } : {}),
```

with:

```ts
      ...(plan.legal.length > 0 || joinGroups ? { finishOrder: finishOrder(plan) } : {}),
      ...(endCard ? { endCard } : {}),
      ...(joinGroups ? { joinGroups, finalJoin: true as const } : {}),
```

(d) In `tvcCreditSteps`, replace:

```ts
  steps.push({ kind: 'edit', count: n + 5 })
```

with:

```ts
  // J4: one join per half plus the final join when the plan has more than
  // 12 shots; otherwise the single join, so the count stays n + 5.
  const groups = joinGroupsFor(plan)
  const joins = groups ? groups.length + 1 : 1
  steps.push({ kind: 'edit', count: n + 4 + joins })
```

(e) In `planTvc.ts` line 385, append one sentence to the end of the `description` string, just before its closing `'`, after `…for composite_end_card.`. Keep the existing text unchanged.

```
 A 30s plan may have up to 20 shots; when it has more than 12, the finish slice also has joinGroups (two lists of shot numbers) and finalJoin true, and finishOrder lists the three joins (assemble_clips group 1, group 2, final).
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/tvcPlan30s.test.ts src/mastra/tools/tvcPlan.test.ts src/mastra/tools/planTvc.test.ts && pnpm exec tsc --noEmit`
Expected: PASS, with no type errors. The existing `tvcPlan.test.ts` finish-order and "slices and prices exactly as before" tests pass unedited.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/tvcPlan.ts apps/agent-orchestrator/src/mastra/tools/tvcPlan30s.test.ts apps/agent-orchestrator/src/mastra/tools/planTvc.ts apps/agent-orchestrator/src/mastra/tools/planTvc.test.ts
git commit -m "$(cat <<'EOF'
feat(tvc-plan): finish slice joinGroups, three-join finish order and price (J2, J4, E6)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: real ffmpeg proves the two-stage join (J3, E3, E4)

This task adds a test only. `assemble_clips` does not change, so the test is expected to pass on its first run. It is the proof that the existing tool keeps fps, length and the seam fade across two stages. If it fails, do not change `assembleClips.ts`: report the measured values.

**Files:**
- Create: `apps/agent-orchestrator/src/mastra/tools/assembleClips.twoStage.realffmpeg.test.ts`

**Interfaces:**
- Consumes: `assembleClips` and `inputSchema` from `./assembleClips.js` (unchanged). The mocks copy `assembleClips.realffmpeg.test.ts`, with one difference: each upload is written back into the fake media cache, so one join's output can be the next join's input.
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the test**

```ts
// Real ffmpeg, not mocked. Tagged: runs only with RUN_REAL_FFMPEG=1.
// Part 2.3 (J3): a 30s ad's 20 clips are joined as two halves, then the two
// halves are joined, with the same assemble_clips. Needs no libass.
import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RequestContext } from '@mastra/core/request-context'

vi.mock('@serverless-saas/credits', () => ({ spendCredits: vi.fn(), resolveRate: vi.fn(async () => null), isUnlimited: vi.fn(async () => true), costMicro: () => 0n }))
vi.mock('../../usage.js', () => ({ getPool: vi.fn() }))
const dir = mkdtempSync(join(tmpdir(), 'asm-two-stage-'))
let outputs = 0
// Each upload is written back into the fake cache, so a join's output can be the next join's input.
vi.mock('../../persistence.js', () => ({
  uploadGeneratedFile: vi.fn(async (_t: string, i: { content: Buffer }) => {
    const fileId = `out${++outputs}`
    writeFileSync(join(dir, `${fileId}.mp4`), i.content)
    return { fileId, name: `${fileId}.mp4`, type: 'video/mp4', size: i.content.length }
  }),
}))
vi.mock('./mediaCache.js', () => ({
  fetchPresignedUrl: vi.fn(async (id: string) => id),
  downloadToSessionCache: vi.fn(async (_s: string, id: string) => ({ filePath: join(dir, `${id}.mp4`) })),
}))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval: vi.fn(async () => false) }))

import { assembleClips } from './assembleClips.js'

const probe = (file: string, entries: string, stream?: string) =>
  execFileSync('ffprobe', ['-v', 'error', ...(stream ? ['-select_streams', stream] : []), '-show_entries', entries, '-of', 'csv=p=0', file]).toString().trim()

/** Peak absolute sample (0..1) of the mono 48 kHz audio between two times. */
function peak(file: string, from: number, to: number): number {
  const pcm = execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(from), '-t', String(to - from), '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'])
  let max = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) max = Math.max(max, Math.abs(pcm.readInt16LE(i)))
  return max / 32768
}

describe.skipIf(!process.env.RUN_REAL_FFMPEG)('assemble_clips two-stage join against real ffmpeg (J3)', () => {
  it('joins 20 clips at 24fps as two halves, then the halves, keeping fps, length and the seam fade', async () => {
    const lens = Array.from({ length: 20 }, (_, i) => [1.5, 1.4, 1.6, 1.5][i % 4])
    lens.forEach((d, i) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=24:duration=${d}`, '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 20}:duration=${d}`, '-shortest', '-c:v', 'libx264', '-c:a', 'aac', join(dir, `c${i}.mp4`)]))
    const rc = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't', conversationId: 'c', idToken: 'tok' })) rc.set(k, v)
    const run = (clipFileIds: string[], roomTone: boolean, id: string) =>
      assembleClips.execute!({ clipFileIds, preserveAudio: true, roomTone, aspectRatio: '16:9' } as never, { requestContext: rc, agent: { toolCallId: id } } as never) as Promise<{ fileId?: string; fps?: number; refused?: boolean; refusalReason?: string }>

    const ids = lens.map((_, i) => `c${i}`)
    // Each half is joined as Director does it: preserveAudio and roomTone true.
    const half1 = await run(ids.slice(0, 10), true, 'h1')
    const half2 = await run(ids.slice(10), true, 'h2')
    expect(half1).toMatchObject({ fps: 24 })
    expect(half2).toMatchObject({ fps: 24 })
    // The final join: the two halves, no transitions, roomTone false (each half already carries it).
    const final = await run([half1.fileId!, half2.fileId!], false, 'final')
    expect(final.refused).toBeFalsy()
    expect(final).toMatchObject({ fps: 24 })

    const out = join(dir, `${final.fileId}.mp4`)
    expect(probe(out, 'stream=r_frame_rate', 'v:0')).toBe('24/1')
    const total = lens.reduce((a, b) => a + b, 0)
    const dur = parseFloat(probe(out, 'format=duration'))
    // assemble_clips's own tolerance, applied over all 20 pieces: 0.1s + 0.03s per piece.
    // Measured on the reference Mac: 30.21s for 30s of pieces.
    expect(Math.abs(dur - total)).toBeLessThanOrEqual(0.1 + 0.03 * lens.length)

    // The seam between the halves gets the 40ms fades: the quietest 10ms
    // window near it is far quieter than the tone just before it.
    const seam = parseFloat(probe(join(dir, `${half1.fileId}.mp4`), 'stream=duration', 'v:0'))
    const before = peak(out, seam - 0.5, seam - 0.3)
    let quietest = Infinity
    for (let t = seam - 0.15; t <= seam + 0.15; t += 0.005) quietest = Math.min(quietest, peak(out, t, t + 0.01))
    expect(before).toBeGreaterThan(0.05)
    expect(quietest).toBeLessThan(before * 0.25)
  }, 300_000)

  it('still refuses a 13-clip join (the 12-clip cap is unchanged)', async () => {
    const { inputSchema } = await import('./assembleClips.js')
    expect(inputSchema.safeParse({ clipFileIds: Array.from({ length: 13 }, (_, i) => `c${i}`), preserveAudio: true, aspectRatio: '16:9' }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run it untagged to confirm it skips cleanly**

Run: `cd apps/agent-orchestrator && pnpm exec vitest run src/mastra/tools/assembleClips.twoStage.realffmpeg.test.ts`
Expected: `2 skipped`, no failures.

- [ ] **Step 3: Run it for real (local Mac, no libass needed)**

Run: `cd apps/agent-orchestrator && RUN_REAL_FFMPEG=1 pnpm exec vitest run src/mastra/tools/assembleClips.twoStage.realffmpeg.test.ts src/mastra/tools/assembleClips.realffmpeg.test.ts`
Expected: PASS, 3 tests, in about 10 s. On the reference Mac (ffmpeg 8.x) this was measured: final 30.21 s for 30.0 s of pieces, `before` peak about 0.09, and the quietest window at the seam 0. If it fails, record `dur`, `seam`, `before` and `quietest` and report them. Do not loosen a threshold or touch `assembleClips.ts` without the controller's agreement.

- [ ] **Step 4: Confirm `assembleClips.ts` is unchanged**

Run: `git diff --stat origin/main -- apps/agent-orchestrator/src/mastra/tools/assembleClips.ts`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-orchestrator/src/mastra/tools/assembleClips.twoStage.realffmpeg.test.ts
git commit -m "$(cat <<'EOF'
test(assemble-clips): real-ffmpeg proof of the 30s two-stage join (J3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: the skill text (J5), append only

**Files:**
- Modify (append only): `products/agent-platform/packages/api/seeds/official-skills/tvc-ad/director.md`
- Modify (append only): `products/agent-platform/packages/api/seeds/official-skills/tvc-ad.md`
- Test: `products/agent-platform/packages/api/__tests__/officialSkillsSeed.test.ts`

**Interfaces:**
- Consumes (Tasks 1–2): the finish-slice keys `joinGroups` and `finalJoin`; the `finishOrder` steps `assemble_clips group 1`, `assemble_clips group 2` and `assemble_clips final`; the reasons `JOIN_SPLIT_IMPOSSIBLE` and `REFERENCE_TOO_MANY_CUTS`. The shipped `DURATION_MISMATCH` reason from `assemble_clips` is unchanged.
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the failing test**

In `officialSkillsSeed.test.ts`, add a new `it` directly after the `it('tvc-ad follows the final-review rulings', …)` block, before `it('each entry file exists and is non-empty', …)`:

```ts
  it('tvc-ad offers 30 seconds and joins it in two stages (Part 2.3, append only)', () => {
    const tvc = OFFICIAL_SKILLS.find((s) => s.slug === 'tvc-ad')!;
    const card = readFileSync(tvc.file, 'utf8');
    const director = readFileSync(tvc.director!.file, 'utf8');
    expect(director).toMatch(/30-second ads and the two-stage join \(supersede the matching lines above\):/);
    expect(director).toMatch(/the length may also be 30 seconds: up to 20 shots, a word cap of 45 across voiceover and lines/);
    expect(director).toMatch(/On JOIN_SPLIT_IMPOSSIBLE, remove continuesFrom from one continuing shot in the middle of the ad and check again\. On REFERENCE_TOO_MANY_CUTS, return the reason to Olmo in plain words\./);
    expect(director).toMatch(/when the finish slice has joinGroups, join each group with assemble_clips in order/);
    expect(director).toMatch(/preserveAudio true, roomTone true, the plan's aspect ratio/);
    expect(director).toMatch(/Then join the two results with assemble_clips: just those two videos in order, preserveAudio true, roomTone false \(each half already carries its room tone\), no transitions/);
    expect(director).toMatch(/"assemble_clips group 1", "assemble_clips group 2" and "assemble_clips final" in finishOrder are these three joins/);
    expect(director).toMatch(/If any of the three joins refuses with DURATION_MISMATCH \(it was refunded\), return the reason to Olmo, saying which join failed and the fileIds of the halves already joined/);
    expect(card).toMatch(/20\. 30-second ads \(supersedes the length list in item 1\): 30 seconds is also offered/);
    expect(card).toMatch(/costs about twice a 15-second one/);
    // The shipped lines are still there, word for word (append only).
    expect(director).toMatch(/assemble_clips once with every recorded clip in shot order \(the carded packshot last\), preserveAudio true, the plan's aspect ratio\./);
    expect(director).toMatch(/step finish: assemble_clips with roomTone true\./);
    expect(card).toMatch(/6 and 20 are also possible/);
    expect(card).not.toMatch(/30 are also possible/);
    expect(card).not.toMatch(/forVoiceoverBlock|overlay_text|plan_tvc|composite_end_card|assemble_clips/);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/officialSkillsSeed.test.ts`
Expected: FAIL on the first new `toMatch`. The other 19 tests PASS.

- [ ] **Step 3: Append the text**

Append to the end of `tvc-ad/director.md`, after a blank line. Do not touch any existing line.

```markdown
30-second ads and the two-stage join (supersede the matching lines above):
- step plan: the length may also be 30 seconds: up to 20 shots, a word cap of 45 across voiceover and lines, every shot 1.2–2.5s and the packshot 2–4s, at most 2 places, and every other rule above. For 30 seconds plan 13–18 moments. The "at most 8 shots" and "6, 15 or 20s" in the lines above do not apply to a 30s ad.
- On JOIN_SPLIT_IMPOSSIBLE, remove continuesFrom from one continuing shot in the middle of the ad and check again. On REFERENCE_TOO_MANY_CUTS, return the reason to Olmo in plain words.
- step finish: when the finish slice has joinGroups, join each group with assemble_clips in order, never every clip at once: the group's recorded clips in shot order (the carded packshot last in the second group), preserveAudio true, roomTone true, the plan's aspect ratio. Then join the two results with assemble_clips: just those two videos in order, preserveAudio true, roomTone false (each half already carries its room tone), no transitions, the plan's aspect ratio. Use the second join's result wherever the lines above use the joined video.
- Follow finishOrder exactly: "assemble_clips group 1", "assemble_clips group 2" and "assemble_clips final" in finishOrder are these three joins.
- If any of the three joins refuses with DURATION_MISMATCH (it was refunded), return the reason to Olmo, saying which join failed and the fileIds of the halves already joined, so a retry repeats only that join.
```

Append to the end of `tvc-ad.md`, after a blank line. Do not touch any existing line. It must not name a tool.

```markdown
20. 30-second ads (supersedes the length list in item 1): 30 seconds is also offered, the most common TV length. Offer it when the user wants a full TV spot or their reference ad is 30 seconds long. Before planning a 30-second ad, tell the user in one plain sentence that it costs about twice a 15-second one, because it has more moments; the plan then shows the exact cost. In Auto mode say it in one line and carry on. If Director reports that a reference ad has more cuts than a 30-second ad can match, tell the user in one plain sentence and offer a shorter cutdown of it, or a 30-second ad at our own pace.
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/officialSkillsSeed.test.ts`
Expected: PASS (20 tests).

Then confirm that nothing was deleted:
Run: `git diff -U0 origin/main -- products/agent-platform/packages/api/seeds/official-skills/ | grep '^-' | grep -v '^---'`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add -f products/agent-platform/packages/api/seeds/official-skills/tvc-ad/director.md products/agent-platform/packages/api/seeds/official-skills/tvc-ad.md
git add products/agent-platform/packages/api/__tests__/officialSkillsSeed.test.ts
git commit -m "$(cat <<'EOF'
feat(tvc-skill): 30-second ads and the two-stage join in Director and Olmo text (J5)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Final check (controller, after Task 4)

Run from the worktree root:

```bash
cd apps/agent-orchestrator && pnpm exec vitest run && pnpm exec tsc --noEmit
RUN_REAL_FFMPEG=1 pnpm exec vitest run src/mastra/tools/assembleClips.twoStage.realffmpeg.test.ts src/mastra/tools/assembleClips.realffmpeg.test.ts
cd ../.. && pnpm --filter @serverless-saas/agent-api exec vitest run __tests__/officialSkillsSeed.test.ts
git diff --stat origin/main -- apps/agent-orchestrator/src/mastra/tools/assembleClips.ts   # must print nothing
```

E8 (talking-head, UGC and animated skills unaffected): they never call `plan_tvc`, and `assemble_clips` is unchanged. The full orchestrator suite passing is the check.

## Deploy (after merge; done by the user, not by an implementer)

1. **No migration, no new credit rate and no Lambda change.**
   - A 30 s ad prices through the existing rates. `tvcCreditSteps` just counts more stills, clips and joins.
   - No `sam deploy`.
2. **The real-ffmpeg proof on the VM** (optional, since it already ran on the Mac; this confirms the VM's ffmpeg):

   ```bash
   cd apps/agent-orchestrator
   RUN_REAL_FFMPEG=1 pnpm exec vitest run src/mastra/tools/assembleClips.twoStage.realffmpeg.test.ts
   ```

   It must PASS, not skip.
3. **Orchestrator and the official skills:** run `./deploy-orch.sh`.
   - It seeds the official skills (the `director.md` and `tvc-ad.md` additions), builds, and restarts `agent-orchestrator`.
   - Check that the `tvc-ad` skill's latest version contains "30-second ads and the two-stage join".
4. **Web:** run `./deploy.sh`. It re-seeds the skills (idempotent) and rebuilds web. Web code is unchanged by this plan.
5. **Live test:** a 30 s India beverage ad, 16:9, with about 16 moments, two places, one continuing shot near the middle, a voiceover, and a disclaimer.
   - Before the plan, check that Olmo says it costs about twice a 15 s ad. Check that the plan's cost shows 3 more joins than a one-join plan of the same shot count.
   - In the trace (`mastra_span_events`), check three `assemble_clips` calls at finish:
     - two with `roomTone: true`, which are the groups from the finish slice's `joinGroups`;
     - one with two clip ids and `roomTone: false`.
   - Check that the split did not fall between the continuing shot and the shot it continues.
   - Check the finished ad is 30 s (within about 0.3 s) and plays at the clips' 24 fps.
   - Listen at the seam between the halves: there is no click and no jump in room tone.
   - Check the music bed runs to the end. `generate_song` makes about 30 s, so a bed that stops a fraction early is a finding to report, not something this plan fixes.
   - Then ask for a 15 s version of the same idea as a new plan. Its finish has one `assemble_clips` call, exactly as before.
