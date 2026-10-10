import { describe, it, expect, vi } from 'vitest'
vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl: vi.fn() }))
import { runPlanTvc, type PlanTvcDeps, type SavedPlan } from './planTvc.js'
import { tvcPlanSchema, type TvcPlan } from './tvcPlan.js'

const plan = (): TvcPlan => tvcPlanSchema.parse({
  brief: { message: 'Ice cold refreshment', category: 'beverage', tier: 'mass', objective: 'brand', market: 'generic', lengthSeconds: 6, aspectRatio: '16:9', productPhotoFileId: 'prod', voiceId: 'v1' },
  look: 'bright, deep focus', locations: ['school corridor'],
  shots: [
    { n: 1, type: 'product_macro', size: 'extreme_close_up', action: 'bottle drops into the slot', durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'voiceover', text: 'Ice cold' },
    { n: 2, type: 'superpower', size: 'wide', action: 'icy wind sweeps the corridor', durationSeconds: 2, brandVisible: true, productVisible: false, audio: 'voiceover' },
    { n: 3, type: 'packshot', size: 'close_up', action: 'bottle on the counter', durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'silent' },
  ],
  voiceover: [{ text: 'Ice cold.', startSeconds: 0.5 }], packshot: { kind: 'product' },
})

function fakeDeps() {
  const store = new Map<string, SavedPlan>()
  const keyToId = new Map<string, string>()
  let n = 0
  const deps: PlanTvcDeps = {
    load: async (id) => { const doc = store.get(id); if (!doc) throw new Error('missing'); return structuredClone(doc) },
    save: async (doc) => { const id = keyToId.get(doc.storageKey) ?? `file-${++n}`; keyToId.set(doc.storageKey, id); store.set(id, structuredClone(doc)); return id },
    price: async () => ({ fullCostCredits: 3, shortfallCredits: 0 }),
    newKey: () => `generated/conv/tvc-plan-${n + 1}.json`,
    stillChecked: () => true,
    detectCutTimes: async () => { throw new Error('not expected') },
    productPhotoInfo: async () => ({ mimeType: 'image/jpeg', pathname: '/generated/conv1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-product-photo.jpg' }),
  }
  return { deps, store }
}

async function recorded() {
  const { deps, store } = fakeDeps()
  const { planFileId } = await runPlanTvc({ action: 'check', plan: plan() }, deps)
  await runPlanTvc({ action: 'record', planFileId: planFileId!, records: [
    { shot: 1, stillFileId: 's1', clipFileId: 'c1' }, { shot: 2, stillFileId: 's2', clipFileId: 'c2' }, { shot: 3, stillFileId: 's3' },
  ], narrationFileIds: ['n1'], songFileId: 'song1' }, deps)
  return { deps, store, planFileId }
}

describe('C1: plan_tvc get "plan"', () => {
  it('returns the saved plan with every recorded file id stripped, authored fields kept byte-equal', async () => {
    const { deps, planFileId } = await recorded()
    const out = await runPlanTvc({ action: 'get', planFileId: planFileId!, slice: 'plan' }, deps)
    const sliced = JSON.parse(out.slice!)
    // No recorded file ids survive.
    expect(sliced.shots.map((s: { stillFileId?: string }) => s.stillFileId)).toEqual([undefined, undefined, undefined])
    expect(sliced.shots.map((s: { clipFileId?: string }) => s.clipFileId)).toEqual([undefined, undefined, undefined])
    expect(sliced.narrationFileIds).toBeUndefined()
    expect(sliced.songFileId).toBeUndefined()
    expect(sliced.jingleFileId).toBeUndefined()
    expect(sliced.signoffFileId).toBeUndefined()
    expect(sliced.signoffSeconds).toBeUndefined()
    // Authored fields kept byte-equal.
    expect(sliced.brief).toEqual(plan().brief)
    expect(sliced.look).toEqual(plan().look)
    expect(sliced.locations).toEqual(plan().locations)
    expect(sliced.packshot).toEqual(plan().packshot)
    expect(sliced.voiceover).toEqual(plan().voiceover)
    expect(sliced.shots.map((s: { n: number; type: string; action: string }) => ({ n: s.n, type: s.type, action: s.action })))
      .toEqual(plan().shots.map((s) => ({ n: s.n, type: s.type, action: s.action })))
  })

  it('round-trips through check: a plan-slice edit keeps the stills and narration (carryOver)', async () => {
    const { deps, store, planFileId } = await recorded()
    const sliceOut = await runPlanTvc({ action: 'get', planFileId: planFileId!, slice: 'plan' }, deps)
    const edited = JSON.parse(sliceOut.slice!)
    edited.shots[1].durationSeconds = 2.5
    edited.shots[0].durationSeconds = 1.5
    const checkOut = await runPlanTvc({ action: 'check', plan: edited, planFileId: planFileId! }, deps)
    expect(checkOut.errors).toEqual([])
    const saved = store.get(checkOut.planFileId!)!.plan
    expect(saved.shots.map((s) => s.stillFileId)).toEqual(['s1', 's2', 's3'])
    expect(saved.narrationFileIds).toEqual(['n1'])
    expect(saved.songFileId).toEqual('song1')
  })

  it('the slice input documents "plan"', async () => {
    const { planTvcInputSchema } = await import('./planTvc.js')
    expect(planTvcInputSchema.shape.slice.description).toContain('"plan"')
  })
})
