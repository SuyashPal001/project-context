import { describe, it, expect, vi } from 'vitest'
vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl: vi.fn(), downloadToSessionCache: vi.fn() }))
vi.mock('@serverless-saas/credits', () => ({ spendCredits: vi.fn(), resolveRate: vi.fn(async () => null), isUnlimited: vi.fn(async () => true), costMicro: () => 0n }))
vi.mock('../../usage.js', () => ({ getPool: vi.fn() }))
import { runRenderAnimatic, type AnimaticDeps, type RenderJob } from './renderAnimatic.js'
import { tvcPlanSchema, type TvcPlan } from './tvcPlan.js'

const plan = (extra: Record<string, unknown> = {}): TvcPlan => tvcPlanSchema.parse({
  brief: { message: 'Ice cold', category: 'beverage', tier: 'mass', objective: 'brand', market: 'generic', lengthSeconds: 6, aspectRatio: '9:16', productPhotoFileId: 'prod', voiceId: 'v1', brandName: 'Bubbli' },
  look: 'bright', locations: ['kitchen'],
  shots: [
    { n: 1, type: 'hook', size: 'close_up', action: 'can drops', location: 0, durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'voiceover', stillFileId: 's1' },
    { n: 2, type: 'reaction', size: 'wide', action: 'she smiles', location: 0, durationSeconds: 1.5, brandVisible: false, productVisible: false, audio: 'voiceover', stillFileId: 's2' },
    { n: 3, type: 'packshot', size: 'close_up', action: 'can on counter', location: 0, durationSeconds: 2.5, brandVisible: true, productVisible: true, audio: 'silent', stillFileId: 's3' },
  ],
  voiceover: [{ text: 'Bubbli. Ice cold.', startSeconds: 0.3 }],
  packshot: { kind: 'product', tagline: 'Feel the chill' },
  narrationFileIds: ['n1'], songFileId: 'b1',
  ...extra,
})

function deps(p: TvcPlan, over: Partial<AnimaticDeps> = {}) {
  const log: string[] = []
  const jobs: RenderJob[] = []
  const d: AnimaticDeps = {
    loadPlan: async () => p,
    fetchLocal: async (id) => ({ path: `/tmp/${id}`, buf: Buffer.from('\x89PNG') }),
    timeBlocks: async () => ({ timed: [{ start: 0.3, duration: 1.8 }], blockLufs: [-20] }),
    bedLufs: async () => -20,
    inspectLogo: async () => ({ width: 400, height: 200, transparent: true }),
    charge: async () => { log.push('charge'); return 'ok' },
    refund: async () => { log.push('refund') },
    render: async (job) => { jobs.push(job); log.push('render'); return '/tmp/out.mp4' },
    upload: async (_path, legal) => { log.push(legal ? 'upload-legal' : 'upload'); return { fileId: 'anim1', name: 'Animatic Bubbli.mp4', fileType: 'video/mp4', size: 10 } },
    voiceHeard: () => { log.push('heard') },
    ...over,
  }
  return { d, log, jobs }
}

describe('render_animatic refusals are free', () => {
  it.each([
    ['a shorter version', plan({ cutdownOf: { planFileId: 'orig' } }), /^ANIMATIC_CUTDOWN: /],
    ['a shot with no still', (() => { const p = plan(); p.shots[1].stillFileId = undefined; return p })(), /^ANIMATIC_STILLS_MISSING: shot 2 /],
    ['no narration recorded', plan({ narrationFileIds: undefined }), /^ANIMATIC_AUDIO_MISSING: .*narration/],
    ['no music recorded', plan({ songFileId: undefined }), /^ANIMATIC_AUDIO_MISSING: .*music/],
  ])('%s', async (_name, p, reason) => {
    const { d, log } = deps(p)
    const out = await runRenderAnimatic('p1', d)
    expect(out.refusalReason).toMatch(reason)
    expect(log).not.toContain('charge')
  })
  it('a quiet bed and a voiceover that does not fit are refused before the charge', async () => {
    const a = deps(plan(), { bedLufs: async () => -60 })
    expect((await runRenderAnimatic('p1', a.d)).refusalReason).toBe('MUSIC_BED_INAUDIBLE')
    const b = deps(plan(), { timeBlocks: async () => ({ refusalReason: 'VOICEOVER_TOO_LONG' }) })
    expect((await runRenderAnimatic('p1', b.d)).refusalReason).toBe('VOICEOVER_TOO_LONG')
    expect([...a.log, ...b.log]).not.toContain('charge')
  })
})

describe('render_animatic charges, renders, uploads', () => {
  it('passes the timing, stills, zoom and text to the render, and marks the voice as heard', async () => {
    const { d, log, jobs } = deps(plan())
    const out = await runRenderAnimatic('p1', d)
    expect(out.fileId).toBe('anim1')
    expect(log).toEqual(['charge', 'render', 'upload', 'heard'])
    expect(jobs[0].frames).toEqual([48, 36, 60])
    expect(jobs[0].stillPaths).toEqual(['/tmp/s1', '/tmp/s2', '/tmp/s3'])
    expect(jobs[0].width).toBe(1080)
    expect(jobs[0].ass).toContain('ROUGH CUT')
    expect(jobs[0].ass).toContain('Feel the chill')
  })
  it('a continuing shot renders from the shot it continues', async () => {
    const p = plan(); p.shots[1].stillFileId = undefined; p.shots[1].continuesFrom = 1
    const { d, jobs } = deps(p)
    await runRenderAnimatic('p1', d)
    expect(jobs[0].stillPaths[1]).toBe('/tmp/s1')
    expect(jobs[0].zooms[1][0]).toBeCloseTo(1.04, 6)
  })
  it('a disclaimer stores the file under the legal-text marker', async () => {
    const { d, log } = deps(plan({ legal: [{ text: 'Serve chilled', wholeAd: true }] }))
    await runRenderAnimatic('p1', d)
    expect(log).toContain('upload-legal')
  })
  it.each([
    ['the render fails', { render: async () => { throw new Error('ffmpeg exploded') } }, 'ANIMATIC_FAILED'],
    ['the length guard fires', { render: async () => { throw new Error('ANIMATIC_LENGTH_MISMATCH: 143 frames, expected 144') } }, 'ANIMATIC_LENGTH_MISMATCH'],
    ['the upload fails', { upload: async () => null }, 'STORAGE_FAILED'],
  ])('refunds when %s', async (_n, over, reason) => {
    const { d, log } = deps(plan(), over as Partial<AnimaticDeps>)
    const out = await runRenderAnimatic('p1', d)
    expect(out.refusalReason).toBe(reason)
    expect(log).toContain('refund')
    expect(log).not.toContain('heard')
  })
  it('insufficient credits stops before the render', async () => {
    const { d, log } = deps(plan(), { charge: async () => 'insufficient' })
    expect((await runRenderAnimatic('p1', d)).insufficientCredits).toBe(true)
    expect(log).not.toContain('render')
  })
})
