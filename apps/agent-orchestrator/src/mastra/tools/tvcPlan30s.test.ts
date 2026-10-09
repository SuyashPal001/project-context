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
