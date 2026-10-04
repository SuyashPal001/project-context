import { describe, it, expect } from 'vitest'
import { countWords, legalHoldSeconds, recordOnPlan, shotStarts, sliceTvcPlan, tvcCreditSteps, tvcPlanSchema, validateTvcPlan, type TvcPlan } from './tvcPlan.js'

// A valid 15s ambassador spot: 7 shots summing to 15s, packshot last.
function goodPlan(): TvcPlan {
  return tvcPlanSchema.parse({
    brief: {
      message: 'Lips that stay soft all day', category: 'beauty', tier: 'premium', objective: 'launch',
      market: 'generic', lengthSeconds: 15, aspectRatio: '9:16', productPhotoFileId: 'prod-1', actorAvatarId: 'av-1',
    },
    look: 'low-key light, shallow focus, slow moves',
    locations: ['sunlit studio', 'beach at golden hour'],
    shots: [
      { n: 1, type: 'hook', size: 'close_up', action: 'she turns to camera holding the lipstick', location: 0, durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'line', line: 'Out of office.' },
      { n: 2, type: 'lifestyle', size: 'wide', action: 'she walks on the beach', location: 1, durationSeconds: 2, brandVisible: false, productVisible: false, audio: 'voiceover' },
      { n: 3, type: 'product_macro', size: 'extreme_close_up', action: 'the bullet twists up', durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'voiceover', text: 'SPF 30' },
      { n: 4, type: 'reach', size: 'medium', action: 'her hand reaches for the lipstick', location: 0, durationSeconds: 1.5, brandVisible: false, productVisible: true, audio: 'voiceover' },
      { n: 5, type: 'reaction', size: 'close_up', action: 'she smiles at her reflection', location: 0, durationSeconds: 2, brandVisible: false, productVisible: false, audio: 'voiceover' },
      { n: 6, type: 'hero', size: 'medium', action: 'she holds the lipstick by her face', location: 1, durationSeconds: 2.5, brandVisible: true, productVisible: true, audio: 'silent' },
      { n: 7, type: 'packshot', size: 'close_up', action: 'the lipstick on driftwood', location: 1, durationSeconds: 3, brandVisible: true, productVisible: true, audio: 'silent' },
    ],
    voiceover: [{ text: 'New Hya lip duo, with hyaluronic acid and SPF thirty.', startSeconds: 2 }],
    packshot: { kind: 'product', tagline: 'Soft all day' },
  })
}

describe('helpers', () => {
  it('counts words and shot starts', () => {
    expect(countWords('  Out of   office. ')).toBe(3)
    expect(shotStarts(goodPlan())).toEqual([0, 2, 4, 6, 7.5, 9.5, 12])
  })
  it('holds a legal line for at least 4s, longer for long text', () => {
    expect(legalHoldSeconds('Creative visualisation')).toBe(4)
    expect(legalHoldSeconds('one two three four five six seven eight nine ten')).toBe(5)
  })
})

describe('validateTvcPlan — a good plan', () => {
  it('passes with no errors', () => {
    expect(validateTvcPlan(goodPlan()).errors).toEqual([])
  })
})

describe('validateTvcPlan — blocking checks', () => {
  const errorsFor = (mutate: (p: TvcPlan) => void) => { const p = goodPlan(); mutate(p); return validateTvcPlan(p).errors.join(' | ') }

  it('1: the message is one sentence of at most 12 words', () => {
    expect(errorsFor((p) => { p.brief.message = 'Soft lips. All day long.' })).toMatch(/one sentence/)
    expect(errorsFor((p) => { p.brief.message = 'one two three four five six seven eight nine ten eleven twelve thirteen' })).toMatch(/12 words/)
  })
  it('2: durations sum to the length and stay in range', () => {
    expect(errorsFor((p) => { p.shots[1].durationSeconds = 3 })).toMatch(/add up to 16/)
    expect(errorsFor((p) => { p.shots[1].durationSeconds = 1; p.shots[6].durationSeconds = 4 })).toMatch(/shot 2 .*1\.2–2\.5s/)
    expect(errorsFor((p) => { p.shots[6].durationSeconds = 1.5; p.shots[5].durationSeconds = 4 })).toMatch(/packshot .*2–4s/)
  })
  it('3: something brand-visible starts before 2.0s', () => {
    expect(errorsFor((p) => { p.shots[0].brandVisible = false })).toMatch(/brand/)
  })
  it('4: the product appears by 3.0s in ads of 15s or less', () => {
    expect(errorsFor((p) => { p.shots[0].productVisible = false; p.shots[2].productVisible = false; p.shots[3].productVisible = false; p.shots[2].brandVisible = true })).toMatch(/product .*3\.0s/)
  })
  it('5: word caps across voiceover and lines', () => {
    expect(errorsFor((p) => { p.voiceover[0].text = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty' })).toMatch(/23 words.*cap 22/)
  })
  it('6: the voiceover ends 2s before the end', () => {
    expect(errorsFor((p) => { p.voiceover[0].startSeconds = 9.5 })).toMatch(/voiceover ends at .*13/)
  })
  it('7: lines — at most 2, medium or close-up, and they fit', () => {
    expect(errorsFor((p) => { p.shots[0].size = 'wide'; p.shots[1].size = 'close_up' })).toMatch(/line .*medium or close-up/)
    expect(errorsFor((p) => { p.shots[0].line = 'I have earned my stripes today friends' })).toMatch(/line .*does not fit/)
    expect(errorsFor((p) => { p.shots[0].line = undefined })).toMatch(/shot 1 .*no line/)
  })
  it('8: no voiceover over a line shot', () => {
    expect(errorsFor((p) => { p.voiceover[0].startSeconds = 0.5 })).toMatch(/overlaps .*line in shot 1/)
  })
  it('9: no two consecutive shots at the same size', () => {
    expect(errorsFor((p) => { p.shots[1].size = 'close_up' })).toMatch(/shots 1 and 2 .*same size/)
  })
  it('10: the packshot is last and only once', () => {
    expect(errorsFor((p) => { p.shots[6].type = 'hero' })).toMatch(/last shot .*packshot/)
    expect(errorsFor((p) => { p.shots[5].type = 'packshot' })).toMatch(/only one packshot/)
  })
  it('11: at most 2 locations, valid indexes, no lines without an actor', () => {
    expect(errorsFor((p) => { p.locations.push('a third place') })).toMatch(/at most 2 locations/)
    expect(errorsFor((p) => { p.shots[1].location = 5 })).toMatch(/shot 2 .*location/)
    expect(errorsFor((p) => { p.brief.actorAvatarId = undefined })).toMatch(/no actor/)
  })
  it('12: on-screen text is at most 3 words, except the packshot', () => {
    expect(errorsFor((p) => { p.shots[2].text = 'with SPF thirty now' })).toMatch(/shot 3 .*3 words/)
  })
  it('shot numbers must run 1..N', () => {
    expect(errorsFor((p) => { p.shots[3].n = 7 })).toMatch(/numbered 1 to 7/)
  })
})

describe('validateTvcPlan — warnings', () => {
  it('India adds "Creative visualisation" for a mechanism shot, once', () => {
    const p = goodPlan(); p.brief.market = 'india'; p.shots[2].type = 'mechanism'
    const result = validateTvcPlan(p)
    expect(result.errors).toEqual([])
    expect(result.plan.legal).toEqual([{ text: 'Creative visualisation', startSeconds: 4 }])
    expect(validateTvcPlan(result.plan).plan.legal).toHaveLength(1)
  })
  it('India food and beverage warns about the veg mark', () => {
    const p = goodPlan(); p.brief.market = 'india'; p.brief.category = 'beverage'
    expect(validateTvcPlan(p).warnings.join(' ')).toMatch(/veg mark/)
  })
})

describe('sliceTvcPlan', () => {
  it('returns only the shots asked for, with their start times', () => {
    const slice = sliceTvcPlan(goodPlan(), 'shots 2-3') as { shots: Array<{ n: number; startSeconds: number }> }
    expect(slice.shots.map((s) => [s.n, s.startSeconds])).toEqual([[2, 2], [3, 4]])
  })
  it('returns the finish slice and the brief slice', () => {
    expect(sliceTvcPlan(goodPlan(), 'finish')).toHaveProperty('voiceover')
    expect(sliceTvcPlan(goodPlan(), 'brief')).toHaveProperty('look')
  })
  it('rejects an unknown slice', () => {
    expect(() => sliceTvcPlan(goodPlan(), 'everything')).toThrow('UNKNOWN_SLICE')
  })
})

describe('recordOnPlan', () => {
  it('records a still, then a clip; a new still clears the old clip', () => {
    let p = recordOnPlan(goodPlan(), 3, { stillFileId: 's3' })
    p = recordOnPlan(p, 3, { clipFileId: 'c3' })
    expect(p.shots[2]).toMatchObject({ stillFileId: 's3', clipFileId: 'c3' })
    p = recordOnPlan(p, 3, { stillFileId: 's3b' })
    expect(p.shots[2].clipFileId).toBeUndefined()
  })
  it('rejects a missing shot', () => {
    expect(() => recordOnPlan(goodPlan(), 99, { stillFileId: 'x' })).toThrow('NO_SUCH_SHOT')
  })
})

describe('tvcCreditSteps', () => {
  it('prices stills, clips, trims, narration, music and the finish edits', () => {
    expect(tvcCreditSteps(goodPlan())).toEqual([
      { kind: 'image', count: 7 }, { kind: 'video', count: 7 }, { kind: 'narration', count: 1 },
      { kind: 'music', count: 1 }, { kind: 'edit', count: 12 },
    ])
  })
})
