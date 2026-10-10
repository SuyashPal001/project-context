import { describe, it, expect } from 'vitest'
import { ANIMATIC_FPS, animaticOverlays, animaticSlice, frameSize, missingAudio, missingStills, pushInFilter, segmentFrames, stillSources, withRoughCutLabel, zoomRanges } from './animatic.js'
import { tvcPlanSchema, type TvcPlan } from './tvcPlan.js'

const plan = (extra: Partial<Record<string, unknown>> = {}): TvcPlan => tvcPlanSchema.parse({
  brief: { message: 'Ice cold', category: 'beverage', tier: 'mass', objective: 'brand', market: 'generic', lengthSeconds: 6, aspectRatio: '9:16', productPhotoFileId: 'prod', voiceId: 'v1', brandName: 'Bubbli' },
  look: 'bright', locations: ['kitchen'],
  shots: [
    { n: 1, type: 'hook', size: 'close_up', action: 'can drops', location: 0, durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'voiceover', text: 'Ice cold', motion: 'pop', stillFileId: 's1' },
    { n: 2, type: 'reaction', size: 'wide', action: 'she smiles', location: 0, durationSeconds: 1.5, brandVisible: false, productVisible: false, audio: 'voiceover', stillFileId: 's2' },
    { n: 3, type: 'packshot', size: 'close_up', action: 'can on counter', location: 0, durationSeconds: 2.5, brandVisible: true, productVisible: true, audio: 'silent', stillFileId: 's3' },
  ],
  voiceover: [{ text: 'Bubbli. Ice cold.', startSeconds: 0.3 }],
  packshot: { kind: 'product', tagline: 'Feel the chill', motion: 'fade' },
  legal: [{ text: 'Serve chilled', wholeAd: true }],
  ...extra,
})

describe('segmentFrames', () => {
  it('cuts on cumulative boundaries, so 20 shots of 1.45s still add up to the exact frame count', () => {
    const durations = Array.from({ length: 20 }, (_, i) => (i === 19 ? 2.45 : 1.45))
    const frames = segmentFrames(durations)
    expect(frames.reduce((a, b) => a + b, 0)).toBe(Math.round(30 * ANIMATIC_FPS))
    const even = frames.slice(0, 19)
    expect(Math.max(...even) - Math.min(...even)).toBeLessThanOrEqual(1)
  })
  it('a 6s plan of 2, 1.5 and 2.5s gives 48, 36 and 60 frames', () => {
    expect(segmentFrames([2, 1.5, 2.5])).toEqual([48, 36, 60])
  })
})

describe('stills and zoom', () => {
  it('every shot needs a still, except a continuing shot, which uses the shot it continues', () => {
    const p = plan(); p.shots[1].stillFileId = undefined; p.shots[1].continuesFrom = 1
    expect(missingStills(p)).toEqual([])
    expect(stillSources(p)).toEqual(['s1', 's1', 's3'])
    p.shots[2].stillFileId = undefined
    expect(missingStills(p)).toEqual([3])
  })
  it('zooms 1.00 to 1.04, and a continuing shot carries on from where the last one stopped', () => {
    const p = plan(); p.shots[1].continuesFrom = 1
    const z = zoomRanges(p)
    expect(z[0]).toEqual([1, 1.04])
    expect(z[1][0]).toBeCloseTo(1.04, 6)
    expect(z[1][1]).toBeCloseTo(1.04 + 0.04 * (1.5 / 2), 6)
    expect(z[2]).toEqual([1, 1.04])
  })
  it('pushInFilter scales and pads to the frame, supersamples, then zooms over exactly the frames', () => {
    const f = pushInFilter(1080, 1920, 48, [1, 1.04])
    expect(f).toBe("scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,scale=2160:3840,zoompan=z='1+0.04*on/47':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=48:s=1080x1920:fps=24,setsar=1,format=yuv420p")
    expect(frameSize('16:9')).toEqual({ width: 1920, height: 1080 })
  })
})

describe('missingAudio and the animatic slice', () => {
  it('names the narration, the music and the sung sign-off that are not recorded', () => {
    expect(missingAudio(plan())).toEqual(['narration', 'music'])
    expect(missingAudio(plan({ narrationFileIds: ['n1'], songFileId: 'b1' }))).toEqual([])
    const j = plan({ narrationFileIds: ['n1'], songFileId: 'b1' }); j.brief.jingle = { line: 'Bubbli, feel the chill', style: 'pop, bright, female' }
    expect(missingAudio(j)).toEqual(['sung sign-off'])
    expect(missingAudio(plan({ voiceover: [], songFileId: 'b1' }))).toEqual([])
  })
  it('the slice lists what to make in order, ending with record and render', () => {
    const s = animaticSlice(plan())
    expect(s.recorded).toEqual({ narration: false, music: false, signoff: false })
    expect(s.animaticOrder).toEqual(['generate_narration (one per voiceover block)', 'generate_song', 'plan_tvc record', 'render_animatic'])
    expect(animaticSlice(plan({ narrationFileIds: ['n1'], songFileId: 'b1' })).animaticOrder).toEqual(['render_animatic'])
    const j = plan({ voiceover: [], songFileId: 'b1' }); j.brief.jingle = { line: 'Bubbli', style: 'pop' }
    expect(animaticSlice(j).animaticOrder).toEqual(['generate_jingle', 'plan_tvc record', 'render_animatic'])
  })
})

describe('animaticOverlays', () => {
  it('builds the finish\'s text: shot text top, tagline centre large, legal bottom', () => {
    const o = animaticOverlays(plan()) as Array<{ text: string; position: string; size?: string; startSeconds: number; endSeconds: number; motion?: string }>
    expect(o.find((x) => x.text === 'Ice cold')).toMatchObject({ position: 'top', size: 'medium', startSeconds: 0, endSeconds: 2, motion: 'pop' })
    expect(o.find((x) => x.text === 'Feel the chill')).toMatchObject({ position: 'center', size: 'large', startSeconds: 3.5, endSeconds: 6, motion: 'fade' })
    expect(o.find((x) => x.text === 'Serve chilled')).toMatchObject({ position: 'bottom', size: 'legal', startSeconds: 0, endSeconds: 6 })
  })
  it('a price stamps at centre, or top on the packshot without a logo, centre with one', () => {
    const p = plan(); p.shots[2].price = { amount: '₹49' }
    expect((animaticOverlays(p) as Array<{ price?: unknown; position: string }>).find((x) => x.price)!.position).toBe('top')
    p.brief.logoFileId = 'logo1'
    expect((animaticOverlays(p) as Array<{ price?: unknown; position: string }>).find((x) => x.price)!.position).toBe('center')
  })
  it('caps at 12, dropping shot texts from the middle, never a legal line or the tagline', () => {
    const shots = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, type: i === 11 ? 'packshot' : 'lifestyle', size: i % 2 ? 'wide' : 'close_up', action: `moment ${i + 1}`, location: 0, durationSeconds: i === 11 ? 2.4 : 1.6, brandVisible: true, productVisible: true, audio: 'silent', text: i === 11 ? undefined : `t${i + 1}`, stillFileId: `s${i + 1}` }))
    const p = plan({ shots }); p.brief.lengthSeconds = 20
    const o = animaticOverlays(p) as Array<{ text: string; size?: string }>
    expect(o.length).toBe(12)
    expect(o.some((x) => x.text === 'Feel the chill')).toBe(true)
    expect(o.some((x) => x.size === 'legal')).toBe(true)
    expect(o.some((x) => x.text === 't1')).toBe(true)
    expect(o.some((x) => x.text === 't11')).toBe(true)
  })
  it('refuses when the disclaimer timings have errors', () => {
    const p = plan(); p.legal = [{ text: 'Serve chilled', forVoiceoverBlock: 3 }]
    const out = animaticOverlays(p)
    expect('refusalReason' in out && out.refusalReason).toMatch(/^LEGAL_TIMING_ERRORS: /)
  })
})

describe('withRoughCutLabel', () => {
  it('adds a top-left ROUGH CUT style and one event over the whole ad', () => {
    const ass = withRoughCutLabel('[Script Info]\n\n[V4+ Styles]\nFormat: Name,Fontname\nStyle: top-medium,x\n\n[Events]\nFormat: Layer,Start\n', 6)
    expect(ass).toContain('Style: rough-cut,DejaVu Sans,40,')
    expect(ass.indexOf('Style: rough-cut')).toBeGreaterThan(ass.indexOf('Format: Name,'))
    expect(ass).toContain('Dialogue: 1,0:00:00.00,0:00:06.00,rough-cut,,0,0,0,,ROUGH CUT')
  })
})
