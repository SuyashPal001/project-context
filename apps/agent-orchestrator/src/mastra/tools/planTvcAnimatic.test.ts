import { describe, it, expect, vi } from 'vitest'
vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl: vi.fn(async () => 'https://s3.example/plan.json?x-amz-checksum-mode=ENABLED') }))
import { loadSavedPlan, planTvcInputSchema, runPlanTvc, type PlanTvcDeps, type SavedPlan } from './planTvc.js'
import { tvcPlanSchema, type TvcPlan } from './tvcPlan.js'

const plan = (): TvcPlan => tvcPlanSchema.parse({
  brief: { message: 'Ice cold', category: 'beverage', tier: 'mass', objective: 'brand', market: 'generic', lengthSeconds: 6, aspectRatio: '16:9', productPhotoFileId: 'prod', voiceId: 'v1' },
  look: 'bright', locations: ['kitchen'],
  shots: [
    { n: 1, type: 'product_macro', size: 'extreme_close_up', action: 'can drops', location: 0, durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'voiceover' },
    { n: 2, type: 'superpower', size: 'wide', action: 'icy wind', location: 0, durationSeconds: 2, brandVisible: false, productVisible: false, audio: 'voiceover' },
    { n: 3, type: 'packshot', size: 'close_up', action: 'can on counter', location: 0, durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'silent' },
  ],
  voiceover: [{ text: 'Ice cold.', startSeconds: 0.5 }], packshot: { kind: 'product' },
})

function deps(store: Map<string, SavedPlan>): PlanTvcDeps {
  return {
    load: async (id) => structuredClone(store.get(id)!), save: async () => 'x', price: async () => ({ fullCostCredits: 0, shortfallCredits: 0 }),
    newKey: () => 'k', stillChecked: () => true, detectCutTimes: async () => { throw new Error('no') },
    productPhotoInfo: async () => ({ mimeType: 'image/jpeg', pathname: '/p.jpg' }),
  }
}

describe('plan_tvc get "animatic"', () => {
  it('returns what to make, in order', async () => {
    const store = new Map([['p1', { version: 1 as const, storageKey: 'k', plan: plan() }]])
    const out = await runPlanTvc({ action: 'get', planFileId: 'p1', slice: 'animatic' }, deps(store))
    expect(JSON.parse(out.slice!).animaticOrder).toEqual(['generate_narration (one per voiceover block)', 'generate_song', 'plan_tvc record', 'render_animatic'])
  })
  it('refuses a shorter version', async () => {
    const short = { ...plan(), cutdownOf: { planFileId: 'orig' } }
    const store = new Map([['c1', { version: 1 as const, storageKey: 'k', plan: short }]])
    const out = await runPlanTvc({ action: 'get', planFileId: 'c1', slice: 'animatic' }, deps(store))
    expect(out.refusalReason).toMatch(/^ANIMATIC_CUTDOWN: /)
  })
  it('the slice input documents animatic', () => {
    expect(planTvcInputSchema.shape.slice.description).toContain('"animatic"')
  })
})

describe('loadSavedPlan', () => {
  it('reads the plan through a presigned URL without the checksum parameter', async () => {
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ version: 1, storageKey: 'k', plan: plan(), url }) }))
    vi.stubGlobal('fetch', fetchMock)
    const doc = await loadSavedPlan('p1', 'tok')
    expect(fetchMock.mock.calls[0][0]).toBe('https://s3.example/plan.json')
    expect(doc.plan.brief.lengthSeconds).toBe(6)
    vi.unstubAllGlobals()
  })
})
