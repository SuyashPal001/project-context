import { describe, it, expect } from 'vitest'
import { tvcPlanSchema, validateTvcPlan, type TvcPlan } from './tvcPlan.js'
import {
  CUTDOWN_MAX_SHOTS, cutdownProblems, cutdownRefusal, draftCutdown, fitDurations, fixedLengthReason, inheritFromMaster,
  minCutdownSeconds, pickCutdownShots, rebuildCutdown,
} from './tvcCutdown.js'

// A finished 15s original: every shot has its clip, the narration and the bed are recorded.
// Scores: 1 hook 15, 2 reaction 5, 3 hero 11, 4 lifestyle 4, 5 product_macro 10, 6 packshot 5.
function original15(): TvcPlan {
  return tvcPlanSchema.parse({
    brief: { message: 'Ice cold in one sip', category: 'beverage', tier: 'mass', objective: 'brand', market: 'generic', lengthSeconds: 15, aspectRatio: '16:9', productPhotoFileId: 'prod', voiceId: 'v1', brandName: 'Bubbli' },
    look: 'bright', locations: ['kitchen'],
    shots: [
      { n: 1, type: 'hook', size: 'close_up', action: 'the can drops into frame', location: 0, durationSeconds: 2.5, brandVisible: true, productVisible: true, audio: 'voiceover', clipFileId: 'c1', text: 'Ice cold' },
      { n: 2, type: 'reaction', size: 'wide', action: 'she smiles', location: 0, durationSeconds: 2.5, brandVisible: false, productVisible: false, audio: 'voiceover', clipFileId: 'c2' },
      { n: 3, type: 'hero', size: 'medium', action: 'she lifts the can', location: 0, durationSeconds: 2.5, brandVisible: false, productVisible: true, audio: 'voiceover', clipFileId: 'c3' },
      { n: 4, type: 'lifestyle', size: 'wide', action: 'friends walk past', location: 0, durationSeconds: 2.5, brandVisible: false, productVisible: false, audio: 'voiceover', clipFileId: 'c4' },
      { n: 5, type: 'product_macro', size: 'extreme_close_up', action: 'condensation runs down the can', location: 0, durationSeconds: 2.5, brandVisible: false, productVisible: true, audio: 'silent', clipFileId: 'c5' },
      { n: 6, type: 'packshot', size: 'close_up', action: 'the can on the counter', location: 0, durationSeconds: 2.5, brandVisible: true, productVisible: true, audio: 'silent', clipFileId: 'c6' },
    ],
    voiceover: [{ text: 'Bubbli keeps every moment ice cold and bright.', startSeconds: 0.5 }],
    packshot: { kind: 'product', tagline: 'Feel the chill' },
    legal: [{ text: 'Serve chilled', forVoiceoverBlock: 1, startSeconds: 0.5, endSeconds: 5 }],
    narrationFileIds: ['n1'], songFileId: 's1',
  })
}

// A finished 30s original of 20 shots at 1.4s (packshot 3.4s), sizes cycling
// close_up, wide, medium so the original itself never repeats a size.
const TYPES = ['hero', 'reaction', 'lifestyle', 'product_macro', 'reach', 'hero', 'reaction', 'lifestyle', 'reach'] as const
function original30(): TvcPlan {
  const sizes = ['close_up', 'wide', 'medium'] as const
  const shots = Array.from({ length: 19 }, (_, i) => ({
    n: i + 1, type: i === 0 ? 'hook' : TYPES[(i - 1) % TYPES.length], size: sizes[i % 3], action: `moment ${i + 1}`, location: 0,
    durationSeconds: 1.4, brandVisible: i === 0, productVisible: i % 4 === 0, audio: 'voiceover', clipFileId: `c${i + 1}`,
  }))
  return tvcPlanSchema.parse({
    brief: { message: 'Cold in one sip', category: 'beverage', tier: 'mass', objective: 'brand', market: 'generic', lengthSeconds: 30, aspectRatio: '16:9', productPhotoFileId: 'prod' },
    look: 'bright', locations: ['kitchen'],
    shots: [...shots, { n: 20, type: 'packshot', size: 'wide', action: 'the can', location: 0, durationSeconds: 3.4, brandVisible: true, productVisible: true, audio: 'silent', clipFileId: 'c20' }],
    voiceover: [{ text: 'Cold in one sip.', startSeconds: 3 }], packshot: { kind: 'product' },
  })
}
const withVoiceover = (p: TvcPlan, text = 'Bubbli. Ice cold.'): TvcPlan => ({ ...p, voiceover: [{ text, startSeconds: 0.5 }] })

describe('C2: fixed lengths and fitting', () => {
  it('lines, continuing pairs, flash cuts and a jingle packshot keep their length', () => {
    const m = original15()
    m.shots[2].audio = 'line'; m.shots[2].line = 'So cold'
    m.shots[4].flashCut = true
    m.shots[3].continuesFrom = 3
    m.brief.jingle = { line: 'Bubbli', style: 'pop' }
    expect(fixedLengthReason(m, m.shots[0])).toBeNull()
    expect(fixedLengthReason(m, m.shots[2])).toBe('it has an on-camera line')
    expect(fixedLengthReason(m, m.shots[4])).toBe('it is a flash cut')
    expect(fixedLengthReason(m, m.shots[3])).toBe('it is part of a continuing shot')
    expect(fixedLengthReason(m, m.shots[5])).toBe('the sung sign-off plays over it')
    expect(fixedLengthReason(m, m.shots[5], false)).toBeNull()
    expect(minCutdownSeconds(m, m.shots[0])).toBe(1.2)
    expect(minCutdownSeconds(m, m.shots[5], false)).toBe(2)
  })
  it('takes 0.1s at a time from the shot with the most room, earliest first on a tie', () => {
    const m = original15()
    expect(fitDurations(m, [m.shots[0], m.shots[2], m.shots[5]], 6)).toEqual([1.7, 1.8, 2.5])
  })
  it('keeps an unshortened shot\'s exact length, and returns null when it can\'t fit', () => {
    const m = original15()
    expect(fitDurations(m, [m.shots[0], m.shots[2], m.shots[5]], 7.5)).toEqual([2.5, 2.5, 2.5])
    expect(fitDurations(m, [m.shots[0], m.shots[5]], 6)).toBeNull()
    expect(fitDurations(m, [m.shots[0], m.shots[1], m.shots[2], m.shots[3], m.shots[5]], 6)).toBeNull()
  })
})

describe('C2: problems with a kept set', () => {
  it('a split continuing pair, a same-size cut, no early brand, no early product', () => {
    const m = original15()
    m.shots[3].continuesFrom = 3
    const ps = cutdownProblems(m, [m.shots[1], m.shots[2], m.shots[5]], [2, 1.5, 2.5], 6)
    expect(ps).toContain('shot 4 continues shot 3; keep both or neither')
    expect(ps).toContain('the brand must be on screen before 2.0s: keep a brandVisible shot at the start')
    expect(cutdownProblems(m, [m.shots[0], m.shots[5]], [3.5, 2.5], 6)).toContain('shots 1 and 6 are the same size (close_up); change one, or give them different angles')
    const noProduct = original15(); noProduct.shots[0].productVisible = false
    expect(cutdownProblems(noProduct, [noProduct.shots[0], noProduct.shots[1], noProduct.shots[5]], [1.7, 1.8, 2.5], 6)).toContain('the product must appear by 3.0s: keep a productVisible shot near the start')
  })
})

describe('C2: picking', () => {
  it('15s to 6s keeps the hook, the hero and the packshot', () => {
    expect(pickCutdownShots(original15(), 6)).toEqual([1, 3, 6])
  })
  it('a 20-shot 30s original: 15s and 6s are found fast, fit exactly and pass the plan check', () => {
    const m = original30()
    for (const len of [15, 6]) {
      const t0 = Date.now()
      const keep = pickCutdownShots(m, len)
      expect(Date.now() - t0).toBeLessThan(1000)
      expect(keep).not.toBeNull()
      expect(keep![keep!.length - 1]).toBe(20)
      expect(keep).toEqual([...keep!].sort((a, b) => a - b))
      const out = draftCutdown(m, 'orig', len)
      if ('error' in out) throw new Error(out.error)
      expect(out.draft.shots.reduce((n, s) => n + s.durationSeconds, 0)).toBeCloseTo(len, 5)
      expect(validateTvcPlan(withVoiceover(out.draft)).errors).toEqual([])
    }
    // 1.4s shots can't fill 15s in 8 moments, so the cap rises until they can (D: pace first).
    expect(pickCutdownShots(m, 15)!.length).toBe(10)
    expect(pickCutdownShots(m, 6)!.length).toBeLessThanOrEqual(CUTDOWN_MAX_SHOTS[6])
  })
  it('is deterministic', () => {
    expect(pickCutdownShots(original30(), 15)).toEqual(pickCutdownShots(original30(), 15))
  })
  it('never puts an on-camera line in a 6s cut (review M7)', () => {
    const m = original15(); m.shots[2].audio = 'line'; m.shots[2].line = 'So cold'
    expect(pickCutdownShots(m, 6)).toEqual([1, 5, 6])
  })
  it('a price shot never shrinks under 1.2s, even from a reference-matched original (review M8)', () => {
    const m = original15(); m.brief.reference = { videoFileId: 'ref', cutTimes: [2.5, 5, 7.5, 10, 12.5] }
    m.shots[2].price = { amount: '₹49' }
    expect(minCutdownSeconds(m, m.shots[2])).toBe(1.2)
    expect(minCutdownSeconds(m, m.shots[0])).toBe(0.6)
  })
})

describe('C3: refusals and the draft', () => {
  it('refuses a cutdown of a cutdown, a length not shorter, a 6s original and an unfinished original', () => {
    const cut = original15(); cut.cutdownOf = { planFileId: 'x' }
    expect(cutdownRefusal(cut, 6)).toMatch(/^CUTDOWN_OF_CUTDOWN: /)
    expect(cutdownRefusal(original15(), 15)).toBe('CUTDOWN_LENGTH: a cutdown of a 15s ad can be 6 seconds')
    expect(cutdownRefusal(original30(), 30)).toBe('CUTDOWN_LENGTH: a cutdown of a 30s ad can be 6, 15 or 20 seconds')
    const six = original15(); six.brief.lengthSeconds = 6
    expect(cutdownRefusal(six, 6)).toBe('CUTDOWN_LENGTH: a 6s ad is already the shortest; it has no cutdown')
    const unfinished = original15(); delete unfinished.shots[1].clipFileId; delete unfinished.shots[4].clipFileId
    expect(cutdownRefusal(unfinished, 6)).toBe('CUTDOWN_ORIGINAL_UNFINISHED: shots 2, 5 of the original ad have no video yet; finish the original ad first')
  })
  it('drafts the kept shots renumbered, with sources, clips only when unshortened, and the text kept', () => {
    const out = draftCutdown(original15(), 'orig', 6)
    if ('error' in out) throw new Error(out.error)
    const d = out.draft
    expect(d.shots.map((s) => [s.n, s.source?.shot, s.durationSeconds, s.clipFileId])).toEqual([[1, 1, 1.7, undefined], [2, 3, 1.8, undefined], [3, 6, 2.5, 'c6']])
    expect(d.shots[0].source).toEqual({ shot: 1, clipFileId: 'c1', seconds: 2.5 })
    expect(d.shots[0].text).toBe('Ice cold')
    expect(d.brief.lengthSeconds).toBe(6)
    expect(d.brief.reference).toBeUndefined()
    expect(d.voiceover).toEqual([])
    expect(d.legal).toEqual([{ text: 'Serve chilled' }])
    expect(d.songFileId).toBe('s1')
    expect(d.narrationFileIds).toBeUndefined()
    expect(d.cutdownOf).toEqual({ planFileId: 'orig' })
    expect(out.originalVoiceover).toEqual(original15().voiceover)
  })
  it('drops auto legal lines and keeps wholeAd', () => {
    const m = original15()
    m.legal = [{ text: 'Creative visualisation', startSeconds: 1, auto: true }, { text: 'T&C apply', wholeAd: true }]
    const out = draftCutdown(m, 'orig', 6)
    if ('error' in out) throw new Error(out.error)
    expect(out.draft.legal).toEqual([{ text: 'T&C apply', wholeAd: true }])
  })
  it('marks a reference-matched original fromReference and drops the reference', () => {
    const m = original15(); m.brief.reference = { videoFileId: 'ref', cutTimes: [2.5, 5, 7.5, 10, 12.5] }
    const out = draftCutdown(m, 'orig', 6)
    if ('error' in out) throw new Error(out.error)
    expect(out.draft.cutdownOf).toEqual({ planFileId: 'orig', fromReference: true })
    expect(out.draft.brief.reference).toBeUndefined()
  })
  it('keepShots: the packshot is added, a missing shot and a bad set are refused', () => {
    const ok = draftCutdown(original15(), 'orig', 6, [1, 5])
    if ('error' in ok) throw new Error(ok.error)
    expect(ok.draft.shots.map((s) => s.source?.shot)).toEqual([1, 5, 6])
    expect(draftCutdown(original15(), 'orig', 6, [1, 9])).toEqual({ error: 'CUTDOWN_NO_SUCH_SHOT: the original ad has no shot 9' })
    expect((draftCutdown(original15(), 'orig', 6, [2, 4]) as { error: string }).error).toMatch(/^CUTDOWN_SHOTS: .*the brand must be on screen before 2\.0s/)
    expect((draftCutdown(original15(), 'orig', 6, [1]) as { error: string }).error).toBe('CUTDOWN_NO_FIT: shots 1, 6 last 5s in the original and at least 3.2s when shortened; a 6s cutdown needs shots that fit exactly, so keep more shots')
  })
  it('says plainly when the original\'s moments are too short to fill the length (review I3)', () => {
    // 11 × 1.4s + the 3.4s packshot = 18.8s < 20s.
    expect(draftCutdown(original30(), 'orig', 20)).toEqual({ error: 'CUTDOWN_NO_FIT: the original\'s moments are too short to fill 20s in at most 12 moments; try 6 or 15 seconds' })
  })
  it('an on-screen claim moves with its shot; one whose shot was dropped loses its start (review M5)', () => {
    const m = original15()
    m.legal.push({ text: 'Offer valid till stocks last', startSeconds: 5.2 }, { text: 'Friends are not paid actors', startSeconds: 7.6 })
    const out = draftCutdown(m, 'orig', 6)
    if ('error' in out) throw new Error(out.error)
    // Shot 3 started at 5.0s in the original and starts at 1.7s in the cut; shot 4 was dropped.
    expect(out.draft.legal).toEqual([{ text: 'Serve chilled' }, { text: 'Offer valid till stocks last', startSeconds: 1.7 }, { text: 'Friends are not paid actors' }])
  })
})

describe('C4: rebuilding a Director-edited draft from the original', () => {
  const draft = (): TvcPlan => { const out = draftCutdown(original15(), 'orig', 6); if ('error' in out) throw new Error(out.error); return withVoiceover(out.draft) }
  it('overwrites the picture and the clip from the original; keeps text, voiceover, legal and tagline', () => {
    const d = draft()
    d.shots[0].action = 'a dragon appears'; d.shots[0].size = 'wide'; d.shots[2].clipFileId = 'fake'
    d.shots[0].text = 'So cold'
    d.legal = [{ text: 'Serve chilled', forVoiceoverBlock: 1 }]
    d.packshot.tagline = 'Chill'
    d.brief.productPhotoFileId = 'other'
    const out = rebuildCutdown(d, original15())
    if ('errors' in out) throw new Error(out.errors.join(' '))
    expect(out.plan.shots[0].action).toBe('the can drops into frame')
    expect(out.plan.shots[0].size).toBe('close_up')
    expect(out.plan.shots[2].clipFileId).toBe('c6')
    expect(out.plan.shots[0].text).toBe('So cold')
    expect(out.plan.brief.productPhotoFileId).toBe('prod')
    expect(out.plan.legal).toEqual([{ text: 'Serve chilled', forVoiceoverBlock: 1 }])
    expect(out.plan.packshot).toEqual({ kind: 'product', tagline: 'Chill' })
    expect(validateTvcPlan(out.plan).errors).toEqual([])
  })
  it('refuses a missing source, an unknown shot, a wrong order, a too-long shot and a changed fixed shot', () => {
    const noSource = draft(); delete noSource.shots[1].source
    expect(rebuildCutdown(noSource, original15())).toEqual({ errors: ['CUTDOWN_SHOT_SOURCE_MISSING: shots 2 have no source; start from plan_tvc cutdown\'s draft and keep each shot\'s source as given'] })
    const unknown = draft(); unknown.shots[1].source = { shot: 9 }
    expect(rebuildCutdown(unknown, original15())).toEqual({ errors: ['CUTDOWN_NO_SUCH_SHOT: the original ad has no shot 9'] })
    const order = draft(); order.shots[1].source = { shot: 6 }; order.shots[2].source = { shot: 3 }
    expect((rebuildCutdown(order, original15()) as { errors: string[] }).errors).toContain('CUTDOWN_SHOTS: keep the shots in the original order, each once')
    const long = draft(); long.shots[0].durationSeconds = 3
    expect((rebuildCutdown(long, original15()) as { errors: string[] }).errors).toContain('CUTDOWN_SHOT_TOO_LONG: shot 1 (original shot 1) is 3s; its clip is only 2.5s')
    const m = original15(); m.shots[2].audio = 'line'; m.shots[2].line = 'So cold'
    const fixed = draft(); fixed.shots[1].durationSeconds = 1.8
    expect((rebuildCutdown(fixed, m) as { errors: string[] }).errors).toContain('CUTDOWN_SHOT_FIXED: shot 2 (original shot 3) must stay 2.5s because it has an on-camera line')
  })
  it('keeps the jingle only when Director kept it', () => {
    const m = original15(); m.brief.jingle = { line: 'Bubbli', style: 'pop' }
    const d = draft(); delete d.brief.jingle
    const out = rebuildCutdown(d, m)
    if ('errors' in out) throw new Error(out.errors.join(' '))
    expect(out.plan.brief.jingle).toBeUndefined()
  })
})

describe('C4: inheriting recorded files from the original', () => {
  const rebuilt = (text: string): TvcPlan => {
    const out = draftCutdown(original15(), 'orig', 6); if ('error' in out) throw new Error(out.error)
    return withVoiceover(out.draft, text)
  }
  it('reuses the song always, the narration only when every block is word for word and the voice is the same', () => {
    const same = inheritFromMaster(rebuilt('Bubbli keeps every moment ice cold and bright.'), original15())
    expect(same.narrationFileIds).toEqual(['n1'])
    expect(same.songFileId).toBe('s1')
    expect(inheritFromMaster(rebuilt('Bubbli. Ice cold.'), original15()).narrationFileIds).toBeUndefined()
    const otherVoice = rebuilt('Bubbli keeps every moment ice cold and bright.'); otherVoice.brief.voiceId = 'v2'
    expect(inheritFromMaster(otherVoice, original15()).narrationFileIds).toBeUndefined()
  })
  it('reuses the sung sign-off only when it still fits', () => {
    const m = original15(); m.brief.jingle = { line: 'Bubbli', style: 'pop' }
    m.jingleFileId = 'j1'; m.signoffFileId = 'so1'; m.signoffSeconds = 1.5
    const p = rebuilt('Bubbli.'); p.brief.jingle = m.brief.jingle
    expect(inheritFromMaster(p, m).signoffFileId).toBe('so1')
    const tooLate = rebuilt('Bubbli keeps it cold, bright and fun.'); tooLate.brief.jingle = m.brief.jingle; tooLate.voiceover[0].startSeconds = 2
    expect(inheritFromMaster(tooLate, m).signoffFileId).toBeUndefined()
  })
  it('never overwrites what the plan already has', () => {
    const p = rebuilt('Bubbli. Ice cold.'); p.songFileId = 'mine'; p.narrationFileIds = ['mine-n']
    const out = inheritFromMaster(p, original15())
    expect(out.songFileId).toBe('mine')
    expect(out.narrationFileIds).toEqual(['mine-n'])
  })
})
