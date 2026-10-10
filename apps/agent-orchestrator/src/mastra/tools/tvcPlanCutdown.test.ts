import { describe, it, expect } from 'vitest'
import {
  cutError, finishOrder, minShotSeconds, retrimsFor, sliceTvcPlan, tvcCreditSteps, tvcPlanSchema, validateTvcPlan, type TvcPlan,
} from './tvcPlan.js'

// A 6s cutdown of a 15s original: shots 1 and 2 were kept shorter than their
// original clips (no clipFileId yet, so they need a re-trim); the packshot
// kept its length and its clip.
function cutdownPlan(): TvcPlan {
  return tvcPlanSchema.parse({
    brief: { message: 'Ice cold in one sip', category: 'beverage', tier: 'mass', objective: 'brand', market: 'generic', lengthSeconds: 6, aspectRatio: '16:9', productPhotoFileId: 'prod' },
    look: 'bright', locations: ['kitchen'],
    shots: [
      { n: 1, type: 'hook', size: 'close_up', action: 'the can drops', location: 0, durationSeconds: 1.7, brandVisible: true, productVisible: true, audio: 'voiceover', source: { shot: 1, clipFileId: 'c1', seconds: 2.5 } },
      { n: 2, type: 'hero', size: 'medium', action: 'she lifts the can', location: 0, durationSeconds: 1.8, brandVisible: false, productVisible: true, audio: 'voiceover', source: { shot: 3, clipFileId: 'c3', seconds: 2.5 } },
      { n: 3, type: 'packshot', size: 'close_up', action: 'the can', location: 0, durationSeconds: 2.5, brandVisible: true, productVisible: true, audio: 'silent', clipFileId: 'c6', source: { shot: 6, clipFileId: 'c6', seconds: 2.5 } },
    ],
    voiceover: [{ text: 'Bubbli. Ice cold.', startSeconds: 0.5 }], packshot: { kind: 'product' },
    songFileId: 'song1',
    cutdownOf: { planFileId: 'orig' },
  })
}
const plain = (): TvcPlan => { const p = cutdownPlan(); delete p.cutdownOf; p.shots.forEach((s) => { delete s.source; s.clipFileId = `c${s.n}` }); return p }

describe('C1: cutdown fields', () => {
  it('the schema keeps cutdownOf and each shot\'s source', () => {
    const p = cutdownPlan()
    expect(p.cutdownOf).toEqual({ planFileId: 'orig' })
    expect(p.shots[1].source).toEqual({ shot: 3, clipFileId: 'c3', seconds: 2.5 })
  })
  it('a cutdown plan validates like any plan', () => {
    expect(validateTvcPlan(cutdownPlan()).errors).toEqual([])
  })
  it('fromReference keeps the 0.6s minimum without a reference', () => {
    const p = cutdownPlan()
    expect(minShotSeconds(p, p.shots[0])).toBe(1.2)
    p.cutdownOf = { planFileId: 'orig', fromReference: true }
    expect(minShotSeconds(p, p.shots[0])).toBe(0.6)
  })
})

describe('cutError (rule 9, extracted)', () => {
  const p = cutdownPlan()
  it('keeps the same-size message', () => {
    expect(cutError({ ...p.shots[0], n: 4 }, { ...p.shots[2], n: 5 })).toBe('shots 4 and 5 are the same size (close_up); change one, or give them different angles')
  })
  it('keeps the jump-cut message', () => {
    expect(cutError({ ...p.shots[0], angle: 'eye' }, { ...p.shots[1], n: 2, size: 'medium', angle: 'eye' }))
      .toBe('shots 1 and 2 are near-identical framings (same eye angle, close_up then medium): a jump cut. Change the angle, or keep the action in one shot')
  })
  it('passes a real cut', () => {
    expect(cutError(p.shots[0], p.shots[1])).toBeNull()
  })
})

describe('C5: retrims and the finish of a cutdown', () => {
  it('re-trims each shot kept shorter than its clip: centred, the packshot from 0', () => {
    const p = cutdownPlan()
    expect(retrimsFor(p)).toEqual([
      { n: 1, sourceClipFileId: 'c1', startSeconds: 0.4, endSeconds: 2.1 },
      { n: 2, sourceClipFileId: 'c3', startSeconds: 0.35, endSeconds: 2.15 },
    ])
    p.shots[2].durationSeconds = 2.0; delete p.shots[2].clipFileId
    p.shots[0].durationSeconds = 2.2
    expect(retrimsFor(p)[2]).toEqual({ n: 3, sourceClipFileId: 'c6', startSeconds: 0, endSeconds: 2 })
  })
  it('no retrim once the re-trimmed clip is recorded, and none for a plain plan', () => {
    const p = cutdownPlan(); p.shots[0].clipFileId = 't1'; p.shots[1].clipFileId = 't2'
    expect(retrimsFor(p)).toEqual([])
    expect(retrimsFor(plain())).toEqual([])
  })
  it('a plain plan with a stray source never gets retrims (review M1)', () => {
    const p = plain(); p.shots[0].source = { shot: 1, clipFileId: 'c1', seconds: 2.5 }; delete p.shots[0].clipFileId
    expect(retrimsFor(p)).toEqual([])
    expect(finishOrder(p)[0]).toBe('composite_end_card')
  })
  it('finishOrder starts with trim_clip while retrims remain', () => {
    expect(finishOrder(cutdownPlan())).toEqual(['trim_clip', 'composite_end_card', 'assemble_clips', 'mix_voiceover', 'mix_music_bed', 'overlay_text'])
    const done = cutdownPlan(); done.shots[0].clipFileId = 't1'; done.shots[1].clipFileId = 't2'
    expect(finishOrder(done)[0]).toBe('composite_end_card')
    expect(finishOrder(plain())).toEqual(['composite_end_card', 'assemble_clips', 'mix_voiceover', 'mix_music_bed', 'overlay_text'])
  })
  it('the finish slice carries retrims, finishOrder and the music fade for a cutdown', () => {
    const slice = sliceTvcPlan(cutdownPlan(), 'finish') as Record<string, unknown>
    expect(slice.retrims).toEqual(retrimsFor(cutdownPlan()))
    expect(slice.finishOrder).toEqual(finishOrder(cutdownPlan()))
    expect(slice.musicFadeOutAtSeconds).toBe(6)
  })
  it('a plain plan\'s finish slice has none of the cutdown keys', () => {
    const slice = sliceTvcPlan(plain(), 'finish') as Record<string, unknown>
    expect(Object.keys(slice)).not.toContain('retrims')
    expect(Object.keys(slice)).not.toContain('musicFadeOutAtSeconds')
    expect(Object.keys(slice)).not.toContain('finishOrder')
  })
  it('with a recorded sign-off the fade comes from the sign-off, not the length', () => {
    const p = cutdownPlan()
    p.brief.jingle = { line: 'Bubbli', style: 'pop' }
    p.voiceover = []
    p.jingleFileId = 'j'; p.signoffFileId = 's'; p.signoffSeconds = 1.5
    const slice = sliceTvcPlan(p, 'finish') as Record<string, unknown>
    expect(slice.musicFadeOutAtSeconds).toBe(4.2)
  })
  it('a kept jingle not yet recorded gives no length fade (review M2)', () => {
    const p = cutdownPlan()
    p.brief.jingle = { line: 'Bubbli', style: 'pop' }
    p.voiceover = []
    const slice = sliceTvcPlan(p, 'finish') as Record<string, unknown>
    expect(Object.keys(slice)).not.toContain('musicFadeOutAtSeconds')
  })
})

describe('C6: credits for a cutdown', () => {
  it('no stills or video; narration only when not inherited; edits = retrims + 5', () => {
    expect(tvcCreditSteps(cutdownPlan())).toEqual([{ kind: 'narration', count: 1 }, { kind: 'edit', count: 7 }])
    const inherited = cutdownPlan(); inherited.narrationFileIds = ['n1']; inherited.shots[0].clipFileId = 't1'
    expect(tvcCreditSteps(inherited)).toEqual([{ kind: 'edit', count: 6 }])
  })
  it('charges the music and the jingle when they are missing', () => {
    const p = cutdownPlan(); delete p.songFileId; p.brief.jingle = { line: 'Bubbli', style: 'pop' }
    expect(tvcCreditSteps(p)).toEqual([{ kind: 'narration', count: 1 }, { kind: 'music', count: 1 }, { kind: 'music', count: 1 }, { kind: 'edit', count: 7 }])
  })
  it('a plain plan is priced exactly as before', () => {
    expect(tvcCreditSteps(plain())).toEqual([{ kind: 'image', count: 3 }, { kind: 'video', count: 3 }, { kind: 'narration', count: 1 }, { kind: 'music', count: 1 }, { kind: 'edit', count: 8 }])
  })
})
