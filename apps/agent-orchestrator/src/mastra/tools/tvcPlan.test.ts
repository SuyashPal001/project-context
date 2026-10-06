import { describe, it, expect } from 'vitest'
import { countWords, legalHoldSeconds, recordOnPlan, shotStarts, sliceTvcPlan, tvcCreditSteps, tvcPlanSchema, validateTvcPlan, jingleErrors, lastSpeechEnd, signoffTiming, type TvcPlan } from './tvcPlan.js'
import { generateSecondsFor, minShotSeconds, HARD_ACTION_RE } from './tvcPlan.js'
import { shotPromptFor, varietySentence, locationName, CAMERA_GRAMMAR } from './tvcPlan.js'

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

// A 20s plan with n shots: n-1 alternating close-up/wide shots, packshot last, durations summing to 20.
function plan20(n: number): TvcPlan {
  const each = n <= 8 ? 2.5 : 2
  const shots = Array.from({ length: n - 1 }, (_, i) => ({
    n: i + 1, type: i === 0 ? 'hook' : 'lifestyle', size: i % 2 === 0 ? 'close_up' : 'wide', action: 'a moment',
    durationSeconds: each, brandVisible: i === 0, productVisible: i === 0, audio: 'voiceover',
  }))
  const used = each * (n - 1)
  return tvcPlanSchema.parse({
    brief: { message: 'Cold in one sip', category: 'beverage', tier: 'mass', objective: 'brand', market: 'generic', lengthSeconds: 20, aspectRatio: '16:9', productPhotoFileId: 'prod' },
    look: 'bright', locations: ['beach'],
    shots: [...shots, { n, type: 'packshot', size: (n - 1) % 2 === 0 ? 'close_up' : 'medium', action: 'the can', durationSeconds: Math.max(2, 20 - used), brandVisible: true, productVisible: true, audio: 'silent' }],
    voiceover: [{ text: 'Cold in one sip.', startSeconds: 3 }], packshot: { kind: 'product' },
  })
}

describe('validateTvcPlan — a good plan', () => {
  it('passes with no errors', () => {
    expect(validateTvcPlan(goodPlan()).errors).toEqual([])
  })
  it('a mood ad with no voiceover blocks passes', () => {
    const p = goodPlan()
    p.voiceover = []
    p.brief.actorAvatarId = undefined
    p.shots[0] = { ...p.shots[0], audio: 'silent', line: undefined }
    expect(validateTvcPlan(p).errors).toEqual([])
  })
  it('a 6s plan passes', () => {
    const p = tvcPlanSchema.parse({
      brief: { message: 'Ice cold refreshment', category: 'beverage', tier: 'mass', objective: 'brand', market: 'generic', lengthSeconds: 6, aspectRatio: '9:16', productPhotoFileId: 'prod' },
      look: 'bright, deep focus', locations: ['school corridor'],
      shots: [
        { n: 1, type: 'product_macro', size: 'extreme_close_up', action: 'bottle drops into the slot', durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'voiceover' },
        { n: 2, type: 'superpower', size: 'wide', action: 'icy wind sweeps the corridor', durationSeconds: 2, brandVisible: false, productVisible: false, audio: 'silent' },
        { n: 3, type: 'packshot', size: 'close_up', action: 'bottle on the counter', durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'silent' },
      ],
      voiceover: [{ text: 'Ice cold, every time.', startSeconds: 0.3 }], packshot: { kind: 'product' },
    })
    expect(validateTvcPlan(p).errors).toEqual([])
  })
  it('lengths are 6, 15 or 20 seconds; 30 is rejected', () => {
    const p = goodPlan() as unknown as { brief: { lengthSeconds: number } }
    p.brief.lengthSeconds = 30
    expect(tvcPlanSchema.safeParse(p).success).toBe(false)
    p.brief.lengthSeconds = 20
    expect(tvcPlanSchema.safeParse(p).success).toBe(true)
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
  it('at most 12 shots (assemble_clips joins at most 12 clips)', () => {
    expect(validateTvcPlan(plan20(13)).errors.join(' | ')).toMatch(/13 shots; at most 12/)
  })
  it('voiceover blocks never overlap each other', () => {
    expect(errorsFor((p) => { p.voiceover = [{ text: 'New Hya lip duo.', startSeconds: 2 }, { text: 'With SPF thirty.', startSeconds: 2.5 }] })).toMatch(/voiceover blocks 1 and 2 overlap/)
    expect(errorsFor((p) => { p.voiceover = [{ text: 'New Hya lip duo.', startSeconds: 2 }, { text: 'With SPF thirty.', startSeconds: 4 }] })).not.toMatch(/overlap/)
  })
  it('the voiceover ends by the packshot start', () => {
    // 15s: packshot starts at 12.0; ending at 12.4 is inside the 2s tail rule but over the packshot.
    expect(errorsFor((p) => { p.voiceover[0].startSeconds = 8.7 })).toMatch(/end by the packshot's start \(12s\)/)
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
  it('returns the finish slice with the voice and any saved narration and song', () => {
    const p = goodPlan(); p.brief.voiceId = 'voice-7'; p.narrationFileIds = ['n1']; p.songFileId = 'song-1'
    expect(sliceTvcPlan(p, 'finish')).toMatchObject({ brief: { voiceId: 'voice-7' }, narrationFileIds: ['n1'], songFileId: 'song-1' })
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

describe('quality rules (P1, P2, P7–P10)', () => {
  it('P1: generation length covers the shot plus the 0.4s warm-up and margin; line shots get their line', () => {
    const p = goodPlan()
    expect(generateSecondsFor({ ...p.shots[1], durationSeconds: 1.2 })).toBe(3)
    expect(generateSecondsFor({ ...p.shots[1], durationSeconds: 2.5 })).toBe(4)
    expect(generateSecondsFor({ ...p.shots[6], durationSeconds: 3.1 })).toBe(4)
    expect(generateSecondsFor({ ...p.shots[6], durationSeconds: 4 })).toBe(5)
    expect(generateSecondsFor({ ...p.shots[0], line: 'one two three four five six seven eight nine ten eleven twelve' })).toBe(6)
  })
  it('P2: continuesFrom must be the previous shot at the same place; the slice chains it and trims from 0', () => {
    const p = goodPlan()
    p.shots[4].continuesFrom = 3
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/shot 5 continues from shot 3; it can only continue the shot right before it/)
    const q = goodPlan()
    q.shots[4].continuesFrom = 4
    q.shots[4].location = 1
    expect(validateTvcPlan(q).errors.join(' | ')).toMatch(/shot 5 continues shot 4 but is at a different place/)
    const ok = goodPlan()
    ok.shots[4].continuesFrom = 4
    expect(validateTvcPlan(ok).errors).toEqual([])
    const slice = sliceTvcPlan(ok, 'shots 4-5') as { shots: Array<{ n: number; startFromPreviousLastFrame: boolean; trimStartSeconds: number; trimToEnd: boolean; trimFixed?: boolean; trimFromEnd?: boolean; previousClipFileId?: string }> }
    expect(slice.shots[1]).toMatchObject({ n: 5, startFromPreviousLastFrame: true, trimStartSeconds: 0, trimFixed: true })
    expect(slice.shots[0]).toMatchObject({ n: 4, trimToEnd: true, trimFixed: true, trimFromEnd: true })
  })
  it('F1: a continuesFrom chain (3 continues 2 continues 1) is a plan error', () => {
    const p = goodPlan()
    p.shots[4].continuesFrom = 4
    p.shots[5].continuesFrom = 5
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/shot 6 continues shot 5, which itself continues shot 4; continue from one shot only, not a chain/)
  })
  it('F1: the slice carries previousClipFileId for a continuing shot, from the recorded clip it continues', () => {
    let ok = goodPlan()
    ok.shots[4].continuesFrom = 4
    ok = recordOnPlan(ok, 4, { clipFileId: 'clip-4' })
    const slice = sliceTvcPlan(ok, 'shots 4-5') as { shots: Array<{ n: number; previousClipFileId?: string }> }
    expect(slice.shots[1]).toMatchObject({ n: 5, previousClipFileId: 'clip-4' })
  })
  it('P7: a state-changing action needs an endState', () => {
    const p = goodPlan()
    p.shots[2].action = 'the cap pops off on the opener'
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/shot 3 changes an object \("the cap pops off on the opener"\); add endState/)
    p.shots[2].endState = 'the bottle has no cap'
    expect(validateTvcPlan(p).errors).toEqual([])
    expect(HARD_ACTION_RE.test('she pours the tea')).toBe(true)
    expect(HARD_ACTION_RE.test('she smiles')).toBe(false)
  })
  it('P8/P9: same angle and neighbouring sizes is a jump cut; same size needs a different angle', () => {
    const p = goodPlan()
    p.shots[0].angle = 'eye'; p.shots[1].angle = 'eye'
    p.shots[2].size = 'close_up'; p.shots[2].angle = 'side'
    p.shots[3].size = 'close_up'; p.shots[3].angle = 'side'
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/shots 3 and 4 are the same size \(close_up\)/)
    const q = goodPlan()
    q.shots[2].angle = 'eye'; q.shots[3].angle = 'eye'
    q.shots[3].size = 'close_up'
    q.shots[2].size = 'extreme_close_up'
    expect(validateTvcPlan(q).errors.join(' | ')).toMatch(/shots 3 and 4 are near-identical framings/)
    const r = goodPlan()
    r.shots[2].size = 'medium'; r.shots[2].angle = 'low'
    r.shots[3].size = 'medium'; r.shots[3].angle = 'eye'
    expect(validateTvcPlan(r).errors.join(' | ')).not.toMatch(/shots 3 and 4/)
  })
  it('P9: minimum shot length — 1.2s, 0.6s with a reference, 0.3s for a flash cut', () => {
    const p = goodPlan()
    expect(minShotSeconds(p, p.shots[1])).toBe(1.2)
    p.brief.reference = { cutTimes: [2, 4] }
    expect(minShotSeconds(p, p.shots[1])).toBe(0.6)
    p.shots[1].flashCut = true
    expect(minShotSeconds(p, p.shots[1])).toBe(0.3)
  })
  it('P10: a payoff without a concrete physical action gets a warning', () => {
    const p = goodPlan()
    p.shots[5].action = 'she feels joyful and free'
    expect(validateTvcPlan(p).warnings.join(' | ')).toMatch(/shot 6 is the payoff/)
    p.shots[5].action = 'she dances and spins all the way around in one direction, 360°'
    expect(validateTvcPlan(p).warnings.join(' | ')).not.toMatch(/payoff/)
  })
  it('P10: a turn must be written as one direction and complete (v5\'s spin reversed mid-way)', () => {
    const p = goodPlan()
    p.shots[5].action = 'she dances and twirls'
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/shot 6 has a turn \("she dances and twirls"\); write it as one direction and complete/)
    p.shots[5].action = 'she spins all the way around in one direction, 360°'
    expect(validateTvcPlan(p).errors.join(' | ')).not.toMatch(/has a turn/)
  })
  it('a plan saved before these fields still validates (Review Focus 3)', () => {
    expect(validateTvcPlan(goodPlan()).errors).toEqual([])
  })
})

describe('F3: productAnchor', () => {
  it('is true for a product-visible shot that is not continuing, false for a continuing shot even if product-visible', () => {
    let ok = goodPlan()
    ok.shots[4].continuesFrom = 4
    ok.shots[4].productVisible = true
    const slice = sliceTvcPlan(ok, 'shots 4-5') as { shots: Array<{ n: number; productAnchor: boolean }> }
    expect(slice.shots[0]).toMatchObject({ n: 4, productAnchor: true }) // shot 4: productVisible true, not continuing
    expect(slice.shots[1]).toMatchObject({ n: 5, productAnchor: false }) // shot 5: continues shot 4
  })
  it('is false for a shot that does not show the product', () => {
    const p = goodPlan()
    const slice = sliceTvcPlan(p, 'shots 2-2') as { shots: Array<{ n: number; productAnchor: boolean }> }
    expect(slice.shots[0]).toMatchObject({ n: 2, productAnchor: false }) // shot 2: productVisible false
  })
})

describe('places, extras and the shot prompt (P3, P4)', () => {
  function hallwayPlan(): TvcPlan {
    const p = goodPlan()
    p.locations = [{ name: 'busy school hallway', extras: 'students walking past and chatting' }, 'beach at golden hour']
    p.brief.actorLook = 'long dark wavy hair, magenta patterned shirt'
    return p
  }
  it('composes action, place, extras, variety excluding the lead\'s look, camera grammar and look', () => {
    const prompt = shotPromptFor(hallwayPlan(), 1)
    expect(prompt).toMatch(/^she turns to camera holding the lipstick\./)
    expect(prompt).toMatch(/Place: busy school hallway\./)
    expect(prompt).toMatch(/Background: students walking past and chatting\./)
    expect(prompt).toMatch(/none of them has the lead's look \(long dark wavy hair, magenta patterned shirt\)/)
    expect(prompt).toContain(CAMERA_GRAMMAR.hook)
    expect(prompt).toMatch(/No CG effects, no added text\.$/)
  })
  it('a turn shot tells the model the movement never reverses', () => {
    const p = hallwayPlan()
    p.shots[5].action = 'she dances and spins all the way around in one direction, 360°'
    expect(shotPromptFor(p, 6)).toMatch(/one way only and completes; nothing reverses/)
    expect(shotPromptFor(p, 2)).not.toMatch(/nothing reverses/)
  })
  it('product macro shots never get a flat graphic background', () => {
    expect(shotPromptFor(hallwayPlan(), 3)).toMatch(/never a flat graphic background/)
  })
  it('warns when a public place has no extras', () => {
    const p = goodPlan()
    p.locations = ['school hallway', 'beach at golden hour']
    expect(validateTvcPlan(p).warnings.join(' | ')).toMatch(/"school hallway" is a public place; add extras/)
  })
  it('plain string locations still work (Review Focus 3)', () => {
    expect(locationName('beach')).toBe('beach')
    expect(shotPromptFor(goodPlan(), 2)).toMatch(/Place: beach at golden hour\./)
    expect(varietySentence()).not.toMatch(/lead's look \(/)
  })
  it('the shots slice carries the prompt', () => {
    const slice = sliceTvcPlan(hallwayPlan(), 'shots 1-1') as { shots: Array<{ prompt: string }> }
    expect(slice.shots[0].prompt).toMatch(/Background: students/)
  })
})

describe('reference fidelity (P5, P6)', () => {
  it('P5: blocks a product whose type differs from the reference\'s', () => {
    const p = goodPlan()
    p.brief.reference = { productType: { material: 'glass', closure: 'crown cap', openedBy: 'bottle opener' } }
    p.brief.product = { material: 'plastic', closure: 'screw cap', openedBy: 'twist' }
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/REFERENCE_PRODUCT_MISMATCH: the reference uses a glass crown cap product opened with a bottle opener; this product is a plastic screw cap product opened with a twist/)
    p.brief.product = { material: 'glass', closure: 'Crown cap', openedBy: 'bottle opener' }
    expect(validateTvcPlan(p).errors.join(' | ')).not.toMatch(/REFERENCE_PRODUCT_MISMATCH/)
    delete p.brief.product
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/REFERENCE_PRODUCT_MISMATCH: the reference uses a glass crown cap product/)
  })
  it('P6: shot boundaries must sit within 0.15s of the reference cuts', () => {
    const p = goodPlan()
    p.brief.reference = { cutTimes: [2, 4, 6, 7.5, 9.5, 12] }
    expect(validateTvcPlan(p).errors.join(' | ')).not.toMatch(/reference/)
    p.brief.reference = { cutTimes: [2, 4.4, 6, 7.5, 9.5, 12] }
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/the cut after shot 2 is at 4s; the reference cuts at 4.4s/)
    p.brief.reference = { cutTimes: [2, 4] }
    expect(validateTvcPlan(p).errors.join(' | ')).toMatch(/the reference has 2 cuts in 15s; this plan has 6/)
  })
})

describe('jingle (J5)', () => {
  const withJingle = (p = goodPlan()): TvcPlan => ({ ...p, brief: { ...p.brief, jingle: { line: 'Soft all day', style: 'warm pop, female vocal' } } })

  it('the last speech is the later of the voiceover end and a line end (words / 2.7)', () => {
    expect(lastSpeechEnd(goodPlan())).toBe(5.7)
    const p = goodPlan()
    p.shots[5] = { ...p.shots[5], audio: 'line', line: 'Soft all day long.' }
    expect(lastSpeechEnd(p)).toBe(11)
  })
  it('accepts a sign-off that starts 0.75s or more after the last word and fits the packshot plus 2s', () => {
    expect(jingleErrors(withJingle(), 3)).toEqual([])
  })
  it('refuses a sign-off that would start too soon after the voiceover', () => {
    const p = withJingle()
    p.voiceover[0].startSeconds = 8.1 // ends at 11.8
    expect(jingleErrors(p, 3)).toEqual(['JINGLE_OVERLAPS_SPEECH: the sung line would start 0.2s after the last word; shorten the line or end the voiceover earlier'])
    expect(jingleErrors(p, 2.4)).toEqual([])
  })
  it('refuses a sign-off that would start too soon after an on-camera line', () => {
    const p = withJingle()
    p.shots[5] = { ...p.shots[5], audio: 'line', line: 'Soft all day long.' } // ends at 11.0
    expect(jingleErrors(p, 3.6)[0]).toMatch(/^JINGLE_OVERLAPS_SPEECH: the sung line would start 0.4s after the last word/)
  })
  it('refuses a sign-off that would start before the last word even ends (negative gap)', () => {
    const p = withJingle()
    p.shots[5] = { ...p.shots[5], audio: 'line', line: 'Soft all day long.' } // ends at 11.0
    expect(jingleErrors(p, 5)).toEqual(['JINGLE_OVERLAPS_SPEECH: the sung line would start 1s before the last word ends; shorten the line or end the voiceover earlier'])
  })
  it('refuses a sign-off longer than the packshot plus 2s', () => {
    expect(jingleErrors(withJingle(), 5.5)).toContain('JINGLE_TOO_LONG: the sung sign-off is 5.5s; at most 5s (the packshot plus 2s); shorten the line')
  })
  // F1: the sung line must be known to fit at plan-check time, before any money is spent.
  it('JINGLE_WONT_FIT when the estimated sign-off would overlap the voiceover', () => {
    const p = withJingle()
    p.brief.jingle!.line = 'Soft all day long' // 4 words: estimate 2.6s, deadline 11.7s
    p.voiceover[0].startSeconds = 8.05 // ends at 11.8, within VO_TAIL and before the packshot, but after the 11.7s deadline
    expect(validateTvcPlan(p).errors).toEqual([
      'JINGLE_WONT_FIT: the sung line needs about 2.6s at the end, but speech runs until 11.8s; end the voiceover by 11.7s or shorten the line',
    ])
  })
  it('passes when the voiceover ends early enough for the estimated sign-off', () => {
    expect(validateTvcPlan(withJingle()).errors).toEqual([])
  })
  it('a no-jingle plan is unchanged by the F1 check', () => {
    expect(validateTvcPlan(goodPlan()).errors).toEqual([])
  })
  it('the sign-off ends with the ad, and the bed clears 0.3s before it', () => {
    expect(signoffTiming(withJingle())).toBeUndefined()
    expect(signoffTiming({ ...withJingle(), signoffSeconds: 2.4 })).toEqual({ signoffStartSeconds: 12.6, musicFadeOutAtSeconds: 12.3 })
  })
  it('the finish slice carries the jingle and its timing once recorded', () => {
    const p = { ...withJingle(), jingleFileId: 'j1', signoffFileId: 's1', signoffSeconds: 2.4 }
    expect(sliceTvcPlan(p, 'finish')).toMatchObject({
      jingle: { line: 'Soft all day', style: 'warm pop, female vocal' },
      jingleFileId: 'j1', signoffFileId: 's1', signoffSeconds: 2.4, signoffStartSeconds: 12.6, musicFadeOutAtSeconds: 12.3,
    })
  })
  it('prices one more music step when the brief has a jingle', () => {
    expect(tvcCreditSteps(withJingle())).toEqual([
      { kind: 'image', count: 7 }, { kind: 'video', count: 7 }, { kind: 'narration', count: 1 },
      { kind: 'music', count: 1 }, { kind: 'music', count: 1 }, { kind: 'edit', count: 12 },
    ])
  })
})

// Review Focus 2: a plan without a jingle is untouched.
describe('a plan without a jingle slices and prices exactly as before', () => {
  it('has no new keys in any slice, the same credit steps and the same validation', () => {
    const p = goodPlan()
    for (const slice of ['brief', 'finish', 'shots 1-7']) {
      expect(JSON.stringify(sliceTvcPlan(p, slice))).not.toMatch(/jingle|signoff|musicFadeOut/i)
    }
    expect(Object.keys(sliceTvcPlan(p, 'finish') as object)).toEqual(['brief', 'shots', 'voiceover', 'packshot', 'legal', 'narrationFileIds', 'songFileId'])
    expect(tvcCreditSteps(p)).toEqual([
      { kind: 'image', count: 7 }, { kind: 'video', count: 7 }, { kind: 'narration', count: 1 },
      { kind: 'music', count: 1 }, { kind: 'edit', count: 12 },
    ])
    expect(validateTvcPlan(p)).toEqual({ errors: [], warnings: expect.any(Array), plan: expect.any(Object) })
    expect(JSON.stringify(tvcPlanSchema.parse(p))).not.toMatch(/jingle|signoff/i)
  })
})
