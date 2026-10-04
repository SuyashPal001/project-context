import { describe, it, expect } from 'vitest'
import { runPlanTvc, type PlanTvcDeps, type SavedPlan } from './planTvc.js'
import { tvcPlanSchema } from './tvcPlan.js'

const plan = () => tvcPlanSchema.parse({
  brief: { message: 'Ice cold refreshment', category: 'beverage', tier: 'mass', objective: 'brand', market: 'generic', lengthSeconds: 6, aspectRatio: '16:9', productPhotoFileId: 'prod' },
  look: 'bright, deep focus', locations: ['school corridor'],
  shots: [
    { n: 1, type: 'product_macro', size: 'extreme_close_up', action: 'bottle drops into the slot', durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'silent' },
    { n: 2, type: 'superpower', size: 'wide', action: 'icy wind sweeps the corridor', durationSeconds: 2, brandVisible: false, productVisible: false, audio: 'silent' },
    { n: 3, type: 'packshot', size: 'close_up', action: 'bottle on the counter', durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'silent' },
  ],
  voiceover: [], packshot: { kind: 'product' },
})

function fakeDeps() {
  const store = new Map<string, SavedPlan>()
  const keyToId = new Map<string, string>()
  let n = 0
  const deps: PlanTvcDeps = {
    load: async (id) => { const doc = store.get(id); if (!doc) throw new Error('missing'); return doc },
    save: async (doc) => {
      const id = keyToId.get(doc.storageKey) ?? `file-${++n}`
      keyToId.set(doc.storageKey, id); store.set(id, structuredClone(doc)); return id
    },
    price: async () => ({ fullCostCredits: 42, shortfallCredits: 0 }),
    newKey: () => `generated/conv/tvc-plan-${n + 1}.json`,
  }
  return { deps, store }
}

describe('runPlanTvc check', () => {
  it('saves a valid plan and returns its id and cost', async () => {
    const { deps } = fakeDeps()
    const out = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect(out).toMatchObject({ planFileId: 'file-1', costCredits: 42, errors: [] })
  })
  it('returns errors and saves nothing for an invalid plan', async () => {
    const { deps, store } = fakeDeps()
    const bad = plan(); bad.shots[0].brandVisible = false
    const out = await runPlanTvc({ action: 'check', plan: bad }, deps)
    expect(out.errors?.join(' ')).toMatch(/brand/)
    expect(out.planFileId).toBeUndefined()
    expect(store.size).toBe(0)
  })
  it('re-check keeps the storage key and file id, and carries over recorded files for unchanged shots', async () => {
    const { deps } = fakeDeps()
    const first = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    await runPlanTvc({ action: 'record', planFileId: first.planFileId!, shot: 1, stillFileId: 's1' }, deps)
    const changed = plan(); changed.shots[1].action = 'icy wind and snow sweep the corridor'
    const again = await runPlanTvc({ action: 'check', plan: changed, planFileId: first.planFileId }, deps)
    expect(again.planFileId).toBe(first.planFileId)
    const shot1 = await runPlanTvc({ action: 'get', planFileId: first.planFileId!, slice: 'shots 1-2' }, deps)
    const shots = JSON.parse(shot1.slice!).shots
    expect(shots[0].stillFileId).toBe('s1')
    expect(shots[1].stillFileId).toBeUndefined()
  })
})

describe('runPlanTvc get and record', () => {
  it('returns only the requested slice as JSON', async () => {
    const { deps } = fakeDeps()
    const { planFileId } = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    const out = await runPlanTvc({ action: 'get', planFileId: planFileId!, slice: 'shots 2-2' }, deps)
    expect(JSON.parse(out.slice!).shots.map((s: { n: number }) => s.n)).toEqual([2])
  })
  it('records a clip and keeps the same file id', async () => {
    const { deps } = fakeDeps()
    const { planFileId } = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    const out = await runPlanTvc({ action: 'record', planFileId: planFileId!, shot: 2, clipFileId: 'c2' }, deps)
    expect(out.planFileId).toBe(planFileId)
  })
  it('refuses a bad slice or shot in plain words', async () => {
    const { deps } = fakeDeps()
    const { planFileId } = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect((await runPlanTvc({ action: 'get', planFileId: planFileId!, slice: 'all' }, deps)).refusalReason).toBe('UNKNOWN_SLICE')
    expect((await runPlanTvc({ action: 'record', planFileId: planFileId!, shot: 9, clipFileId: 'x' }, deps)).refusalReason).toBe('NO_SUCH_SHOT')
  })
})
