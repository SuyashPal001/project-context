import { describe, it, expect, vi } from 'vitest'
vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl: vi.fn() }))
import { runPlanTvc, type PlanTvcDeps, type SavedPlan } from './planTvc.js'
import { tvcPlanSchema, type TvcPlan } from './tvcPlan.js'

const base = (vo: string[], extra: Partial<TvcPlan> = {}): TvcPlan => tvcPlanSchema.parse({
  brief: { message: 'Fizz that wakes you up', category: 'beverage', tier: 'mass', objective: 'brand', market: 'india', lengthSeconds: 6, aspectRatio: '16:9', productPhotoFileId: 'prod', voiceId: 'v1', brandName: 'Bubbli' },
  look: 'bright', locations: ['kitchen'],
  shots: [
    { n: 1, type: 'hook', size: 'wide', action: 'a girl opens the fridge', endState: 'the fridge door is open', durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'voiceover' },
    { n: 2, type: 'hero', size: 'close_up', action: 'the bottle sweats in her hand', durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'voiceover' },
    { n: 3, type: 'packshot', size: 'medium', action: 'bottle on the counter', durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'silent' },
  ],
  voiceover: vo.map((text, i) => ({ text, startSeconds: 0.2 + i * 1.6 })),
  packshot: { kind: 'product' },
  ...extra,
})

function fakeDeps(over: Partial<PlanTvcDeps> = {}) {
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
    ...over,
  }
  return { deps, store }
}

describe('Part 2.6: claims review at check (D2, C1)', () => {
  it('a plan with no claims validates and saves exactly as before', async () => {
    const { deps, store } = fakeDeps({ claimAnswers: [] })
    const out = await runPlanTvc({ action: 'check', plan: base(['Cold fizz, any time']) }, deps)
    expect(out.errors).toEqual([])
    expect(out.claimsToReview).toBeUndefined()
    const saved = store.get(out.planFileId!)!.plan
    expect(saved.claims).toBeUndefined()
    expect(saved.claimsPending).toBeUndefined()
  })

  it('claims only: saves with claimsPending, returns the id and claimsToReview, and gates the stills (Review Focus 2)', async () => {
    const { deps, store } = fakeDeps({ claimAnswers: [] })
    const out = await runPlanTvc({ action: 'check', plan: base(['India’s No.1 fizz']) }, deps)
    expect(out.planFileId).toBeDefined()
    expect(out.costCredits).toBe(3)
    expect(out.claimsToReview!.map((f) => f.text)).toEqual(['India’s No.1 fizz'])
    expect(out.nextStep).toMatch(/^CLAIM_UNREVIEWED: return claimsToReview to Olmo/)
    expect(store.get(out.planFileId!)!.plan.claimsPending).toBe(true)
    for (const slice of ['shots 1-2', 'animatic', 'finish']) {
      const g = await runPlanTvc({ action: 'get', planFileId: out.planFileId!, slice }, deps)
      expect(g.refusalReason).toMatch(/^CLAIM_UNREVIEWED/)
    }
    const r = await runPlanTvc({ action: 'record', planFileId: out.planFileId!, records: [{ shot: 1, stillFileId: 's1' }] }, deps)
    expect(r.refusalReason).toMatch(/^CLAIM_UNREVIEWED/)
    expect((await runPlanTvc({ action: 'get', planFileId: out.planFileId!, slice: 'brief' }, deps)).slice).toBeDefined()
    expect((await runPlanTvc({ action: 'get', planFileId: out.planFileId!, slice: 'plan' }, deps)).slice).not.toContain('claimsPending')
  })

  it('the user\'s answers on a re-check clear claimsPending and open the slices', async () => {
    const { deps } = fakeDeps({ claimAnswers: [] })
    const first = await runPlanTvc({ action: 'check', plan: base(['India’s No.1 fizz']) }, deps)
    deps.claimAnswers = ["india's no.1 fizz"]
    const again = await runPlanTvc({ action: 'check', planFileId: first.planFileId!, plan: { ...base(['India’s No.1 fizz']), claims: [{ text: 'India’s No.1 fizz', status: 'proof', proof: 'Nielsen MAT Mar 2026' }] } }, deps)
    expect(again.claimsToReview).toBeUndefined()
    expect((await runPlanTvc({ action: 'get', planFileId: first.planFileId!, slice: 'shots 1-2' }, deps)).slice).toBeDefined()
  })

  it('a re-check with no claims keeps every earlier answer (Review Focus 3, C2)', async () => {
    const { deps, store } = fakeDeps({ claimAnswers: ["india's no.1 fizz"] })
    const first = await runPlanTvc({ action: 'check', plan: { ...base(['India’s No.1 fizz']), claims: [{ text: 'India’s No.1 fizz', status: 'no_proof' }] } }, deps)
    deps.claimAnswers = []
    const again = await runPlanTvc({ action: 'check', planFileId: first.planFileId!, plan: base(['India’s No.1 fizz']) }, deps)
    expect(again.claimsToReview).toBeUndefined()
    expect(store.get(first.planFileId!)!.plan.claims).toEqual([{ text: 'India’s No.1 fizz', status: 'no_proof' }])
    expect(again.warnings).toContain('CLAIM_NO_PROOF: "India’s No.1 fizz" is kept without proof; the claims summary lists it under Needs proof before airing')
  })

  it('craft errors come back alone; claims wait until they are fixed (E15, I7)', async () => {
    const { deps } = fakeDeps({ claimAnswers: [] })
    const bad = base(['India’s No.1 fizz'])
    bad.shots[0].durationSeconds = 5
    const out = await runPlanTvc({ action: 'check', plan: bad }, deps)
    expect(out.errors!.length).toBeGreaterThan(0)
    expect(out.claimsToReview).toBeUndefined()
    expect(out.planFileId).toBeUndefined()
  })

  it('Ask mode: an entry Director wrote without the user is ignored (D9, E14)', async () => {
    const { deps } = fakeDeps({ claimAnswers: [] })
    const out = await runPlanTvc({ action: 'check', plan: { ...base(['India’s No.1 fizz']), claims: [{ text: 'India’s No.1 fizz', status: 'proof', proof: 'trust me' }] } }, deps)
    expect(out.claimsToReview!.map((f) => f.text)).toEqual(['India’s No.1 fizz'])
    expect(out.warnings).toContain('CLAIM_NOT_FROM_USER: "India’s No.1 fizz" was not answered by the user; ask them')
  })

  it('Auto mode: no_proof entries pass without answers (D4, E11)', async () => {
    const { deps } = fakeDeps({ claimAnswers: [], autoMode: true })
    const out = await runPlanTvc({ action: 'check', plan: { ...base(['India’s No.1 fizz']), claims: [{ text: 'India’s No.1 fizz', status: 'no_proof' }] } }, deps)
    expect(out.claimsToReview).toBeUndefined()
  })

  it('an edited claim is asked again and the old answer dropped with a warning (E4)', async () => {
    const { deps } = fakeDeps({ claimAnswers: ["india's no.1 fizz"] })
    const first = await runPlanTvc({ action: 'check', plan: { ...base(['India’s No.1 fizz']), claims: [{ text: 'India’s No.1 fizz', status: 'no_proof' }] } }, deps)
    deps.claimAnswers = []
    const again = await runPlanTvc({ action: 'check', planFileId: first.planFileId!, plan: base(['India’s most loved fizz']) }, deps)
    expect(again.claimsToReview!.map((f) => f.text)).toEqual(['India’s most loved fizz'])
    expect(again.warnings).toContain('CLAIM_DROPPED: "India’s No.1 fizz" is no longer in the ad')
  })

  it('a plan saved before this shipped (no claimsPending) is never gated (E9)', async () => {
    const { deps, store } = fakeDeps()
    store.set('old', { version: 1, storageKey: 'k-old', plan: base(['India’s No.1 fizz']) })
    expect((await runPlanTvc({ action: 'get', planFileId: 'old', slice: 'shots 1-2' }, deps)).slice).toBeDefined()
  })

  it('check ignores a claimsPending Director sent', async () => {
    const { deps, store } = fakeDeps({ claimAnswers: [] })
    const out = await runPlanTvc({ action: 'check', plan: { ...base(['Cold fizz']), claimsPending: true } }, deps)
    expect(store.get(out.planFileId!)!.plan.claimsPending).toBeUndefined()
  })

  it('the health category is accepted (D5)', () => {
    expect(() => tvcPlanSchema.parse({ ...base([]), brief: { ...base([]).brief, category: 'health', productName: 'Bubbli Immuno Shots' } })).not.toThrow()
  })
})
