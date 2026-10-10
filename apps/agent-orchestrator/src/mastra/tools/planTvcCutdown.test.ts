import { describe, it, expect, vi } from 'vitest'

vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl: vi.fn() }))

import { runPlanTvc, planTvcInputSchema, type PlanTvcDeps, type SavedPlan } from './planTvc.js'
import { retrimsFor, tvcPlanSchema, type TvcPlan } from './tvcPlan.js'

function original15(): TvcPlan {
  return tvcPlanSchema.parse({
    brief: { message: 'Ice cold in one sip', category: 'beverage', tier: 'mass', objective: 'brand', market: 'generic', lengthSeconds: 15, aspectRatio: '16:9', productPhotoFileId: 'prod', voiceId: 'v1', brandName: 'Bubbli' },
    look: 'bright', locations: ['kitchen'],
    shots: [
      { n: 1, type: 'hook', size: 'close_up', action: 'the can drops into frame', location: 0, durationSeconds: 2.5, brandVisible: true, productVisible: true, audio: 'voiceover', clipFileId: 'c1' },
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

function fakeDeps(extra: Partial<PlanTvcDeps> = {}) {
  const store = new Map<string, SavedPlan>()
  const keyToId = new Map<string, string>()
  const priced: TvcPlan[] = []
  let n = 0
  const deps: PlanTvcDeps = {
    load: async (id) => { const doc = store.get(id); if (!doc) throw new Error('missing'); return structuredClone(doc) },
    save: async (doc) => {
      const id = keyToId.get(doc.storageKey) ?? `file-${++n}`
      keyToId.set(doc.storageKey, id); store.set(id, structuredClone(doc)); return id
    },
    price: async (p) => { priced.push(structuredClone(p)); return { fullCostCredits: 3, shortfallCredits: 0 } },
    newKey: () => `generated/conv/tvc-plan-${n + 1}.json`,
    stillChecked: () => true,
    detectCutTimes: async () => { throw new Error('detectCutTimes not expected in this test') },
    productPhotoInfo: async () => ({ mimeType: 'image/jpeg', pathname: '/generated/conv1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-product-photo.jpg' }),
    ...extra,
  }
  return { deps, store, priced }
}

async function seedOriginal(deps: PlanTvcDeps, plan = original15()): Promise<string> {
  return (await deps.save({ version: 1, storageKey: 'generated/conv/original.json', plan }))!
}
async function draftOf(deps: PlanTvcDeps, id: string, lengthSeconds: 6 | 15 | 20 = 6): Promise<TvcPlan> {
  const out = await runPlanTvc({ action: 'cutdown', planFileId: id, lengthSeconds }, deps)
  return (JSON.parse(out.slice!) as { draft: TvcPlan }).draft
}
const ready = (d: TvcPlan, text = 'Bubbli. Ice cold.'): TvcPlan => ({ ...d, voiceover: [{ text, startSeconds: 0.5 }], legal: [{ text: 'Serve chilled', wholeAd: true }] })

describe('plan_tvc cutdown', () => {
  it('the input schema takes cutdown with a plain-number length and keepShots', () => {
    expect(planTvcInputSchema.safeParse({ action: 'cutdown', planFileId: 'x', lengthSeconds: 6, keepShots: [1, 3] }).success).toBe(true)
    const bad = planTvcInputSchema.safeParse({ action: 'cutdown', planFileId: 'x', lengthSeconds: 10 })
    expect(bad.success).toBe(false)
    expect(JSON.stringify(bad.error?.issues)).toContain('lengthSeconds must be 6, 15 or 20')
  })
  it('returns a draft and the original script, and saves nothing', async () => {
    const { deps, store } = fakeDeps()
    const id = await seedOriginal(deps)
    const out = await runPlanTvc({ action: 'cutdown', planFileId: id, lengthSeconds: 6 }, deps)
    const parsed = JSON.parse(out.slice!) as { draft: TvcPlan; originalVoiceover: TvcPlan['voiceover'] }
    expect(out.planFileId).toBeUndefined()
    expect(parsed.draft.shots.map((s) => s.source?.shot)).toEqual([1, 3, 6])
    expect(parsed.draft.cutdownOf).toEqual({ planFileId: id })
    expect(parsed.originalVoiceover[0].text).toBe('Bubbli keeps every moment ice cold and bright.')
    expect(store.size).toBe(1)
  })
  it('refuses with plain reasons', async () => {
    const { deps } = fakeDeps()
    const id = await seedOriginal(deps)
    expect(await runPlanTvc({ action: 'cutdown', planFileId: id }, deps)).toEqual({ refused: true, refusalReason: 'CUTDOWN_LENGTH_REQUIRED: pass lengthSeconds (6, 15 or 20)' })
    expect((await runPlanTvc({ action: 'cutdown', planFileId: id, lengthSeconds: 15 }, deps)).refusalReason).toMatch(/^CUTDOWN_LENGTH: /)
    const unfinished = original15(); delete unfinished.shots[1].clipFileId
    const id2 = (await deps.save({ version: 1, storageKey: 'generated/conv/o2.json', plan: unfinished }))!
    expect((await runPlanTvc({ action: 'cutdown', planFileId: id2, lengthSeconds: 6 }, deps)).refusalReason).toMatch(/^CUTDOWN_ORIGINAL_UNFINISHED: shots 2 /)
  })
})

describe('plan_tvc check of a cutdown', () => {
  it('saves a new plan, inherits the bed, and prices only what is left', async () => {
    const { deps, store, priced } = fakeDeps()
    const id = await seedOriginal(deps)
    const out = await runPlanTvc({ action: 'check', plan: ready(await draftOf(deps, id)) }, deps)
    expect(out).toMatchObject({ planFileId: 'file-2', errors: [], costCredits: 3 })
    const saved = store.get('file-2')!.plan
    expect(saved.cutdownOf).toEqual({ planFileId: id })
    expect(saved.songFileId).toBe('s1')
    expect(saved.narrationFileIds).toBeUndefined()
    expect(retrimsFor(saved).map((r) => r.n)).toEqual([1, 2])
    expect(priced.at(-1)!.cutdownOf).toBeDefined()
    expect(store.get(id)!.plan).toEqual(original15())
  })
  it('reuses the narration when the script keeps an original block word for word', async () => {
    const { deps, store } = fakeDeps()
    const id = await seedOriginal(deps)
    const draft = await draftOf(deps, id, 6)
    const plan = { ...draft, voiceover: [{ text: 'Bubbli keeps every moment ice cold and bright.', startSeconds: 0.2 }], legal: [] }
    const out = await runPlanTvc({ action: 'check', plan }, deps)
    expect(out.errors).toEqual([])
    expect(store.get(out.planFileId!)!.plan.narrationFileIds).toEqual(['n1'])
  })
  it('overwrites a tampered picture or clip from the original', async () => {
    const { deps, store } = fakeDeps()
    const id = await seedOriginal(deps)
    const plan = ready(await draftOf(deps, id))
    plan.shots[0].action = 'a dragon appears'; plan.shots[2].clipFileId = 'fake'; plan.shots[0].clipFileId = 'fake2'
    const out = await runPlanTvc({ action: 'check', plan }, deps)
    const saved = store.get(out.planFileId!)!.plan
    expect(saved.shots[0].action).toBe('the can drops into frame')
    expect(saved.shots[2].clipFileId).toBe('c6')
    expect(saved.shots[0].clipFileId).toBeUndefined()
  })
  it('a carried disclaimer with no start is a plan error until it is re-pointed', async () => {
    const { deps, store } = fakeDeps()
    const id = await seedOriginal(deps)
    const draft = await draftOf(deps, id)
    const out = await runPlanTvc({ action: 'check', plan: { ...draft, voiceover: [{ text: 'Bubbli. Ice cold.', startSeconds: 0.5 }] } }, deps)
    expect(out.errors?.join(' ')).toMatch(/LEGAL_START_MISSING: legal line "Serve chilled"/)
    expect(store.size).toBe(1)
  })
  it('a re-check keeps a re-trimmed clip that was recorded', async () => {
    const { deps, store } = fakeDeps()
    const id = await seedOriginal(deps)
    const plan = ready(await draftOf(deps, id))
    const first = await runPlanTvc({ action: 'check', plan }, deps)
    await runPlanTvc({ action: 'record', planFileId: first.planFileId, records: [{ shot: 1, clipFileId: 't1' }] }, deps)
    const again = await runPlanTvc({ action: 'check', plan, planFileId: first.planFileId }, deps)
    expect(again.planFileId).toBe(first.planFileId)
    expect(store.get(first.planFileId!)!.plan.shots[0].clipFileId).toBe('t1')
    expect(retrimsFor(store.get(first.planFileId!)!.plan).map((r) => r.n)).toEqual([2])
  })
  it('a cutdown can\'t drop its original, and an original can\'t become a cutdown', async () => {
    const { deps } = fakeDeps()
    const id = await seedOriginal(deps)
    const plan = ready(await draftOf(deps, id))
    const first = await runPlanTvc({ action: 'check', plan }, deps)
    const dropped = structuredClone(plan); delete dropped.cutdownOf
    expect((await runPlanTvc({ action: 'check', plan: dropped, planFileId: first.planFileId }, deps)).refusalReason).toMatch(/^CUTDOWN_CHANGED: this plan is a cutdown of /)
    // A valid cutdown draft checked onto the ORIGINAL's file id: the saved plan there is an original.
    expect((await runPlanTvc({ action: 'check', plan, planFileId: id }, deps)).refusalReason).toMatch(/^CUTDOWN_CHANGED: this plan is an original ad/)
  })
  // Review fix (Important #1): a plan whose shots carry `source` but which has
  // lost `cutdownOf` must be refused before anything is saved or priced.
  it('refuses CUTDOWN_OF_MISSING on a FIRST check when cutdownOf is dropped but the shots still carry source', async () => {
    const { deps, store } = fakeDeps()
    const id = await seedOriginal(deps)
    const draft = ready(await draftOf(deps, id))
    expect(draft.shots.some((s) => s.source)).toBe(true)
    const dropped = structuredClone(draft); delete dropped.cutdownOf
    const out = await runPlanTvc({ action: 'check', plan: dropped }, deps)
    expect(out).toEqual({ refused: true, refusalReason: 'CUTDOWN_OF_MISSING: keep cutdownOf exactly as plan_tvc cutdown gave it, and check again' })
    // Only the seeded original is in the store; nothing new was saved or priced.
    expect(store.size).toBe(1)
  })
  // Review fix (Minor 3): a re-check of an ORIGINAL plan (saved plan has no
  // cutdownOf) that newly carries a cutdownOf must get CUTDOWN_CHANGED, not a
  // misleading CUTDOWN_LENGTH from rebuilding the incoming plan against itself.
  it('a re-check of an original that newly carries a cutdownOf pointing at itself gets CUTDOWN_CHANGED, not CUTDOWN_LENGTH', async () => {
    const { deps, store } = fakeDeps()
    const id = await seedOriginal(deps)
    const saved = (await deps.load(id)).plan
    const tampered = { ...saved, cutdownOf: { planFileId: id } }
    const out = await runPlanTvc({ action: 'check', plan: tampered, planFileId: id }, deps)
    expect(out.refusalReason).toMatch(/^CUTDOWN_CHANGED: this plan is an original ad/)
    expect(store.get(id)!.plan).toEqual(original15())
  })
  // Review fix (Minor 1): editing a shot's on-screen text on a saved cutdown
  // must not drop its re-trimmed/recorded clip.
  it('a re-check with only a shot\'s text changed keeps its re-trimmed clip', async () => {
    const { deps, store } = fakeDeps()
    const id = await seedOriginal(deps)
    const plan = ready(await draftOf(deps, id))
    const first = await runPlanTvc({ action: 'check', plan }, deps)
    await runPlanTvc({ action: 'record', planFileId: first.planFileId, records: [{ shot: 1, clipFileId: 't1' }] }, deps)
    const edited = structuredClone(plan)
    edited.shots[0].text = 'Ice cold now'
    const again = await runPlanTvc({ action: 'check', plan: edited, planFileId: first.planFileId }, deps)
    expect(again.planFileId).toBe(first.planFileId)
    expect(store.get(first.planFileId!)!.plan.shots[0].clipFileId).toBe('t1')
    expect(store.get(first.planFileId!)!.plan.shots[0].text).toBe('Ice cold now')
  })
  it('is not refused for a reference named in the delegation (a cutdown has no reference)', async () => {
    const { deps } = fakeDeps({ expectedReferenceVideoFileId: 'ref-video' })
    const id = await seedOriginal(deps)
    const out = await runPlanTvc({ action: 'check', plan: ready(await draftOf(deps, id)) }, deps)
    expect(out.refused).toBeUndefined()
    expect(out.errors).toEqual([])
  })
  it('refuses when the original can\'t be read', async () => {
    const { deps } = fakeDeps()
    const id = await seedOriginal(deps)
    const plan = ready(await draftOf(deps, id)); plan.cutdownOf = { planFileId: 'gone' }
    expect(await runPlanTvc({ action: 'check', plan }, deps)).toEqual({ refused: true, refusalReason: 'CUTDOWN_ORIGINAL_UNAVAILABLE: could not read the original ad\'s plan; try again' })
  })
  it('the finish slice of a saved cutdown lists the retrims first', async () => {
    const { deps } = fakeDeps()
    const id = await seedOriginal(deps)
    const first = await runPlanTvc({ action: 'check', plan: ready(await draftOf(deps, id)) }, deps)
    const slice = JSON.parse((await runPlanTvc({ action: 'get', planFileId: first.planFileId, slice: 'finish' }, deps)).slice!)
    expect(slice.finishOrder[0]).toBe('trim_clip')
    expect(slice.retrims).toEqual([
      { n: 1, sourceClipFileId: 'c1', startSeconds: 0.4, endSeconds: 2.1 },
      { n: 2, sourceClipFileId: 'c3', startSeconds: 0.35, endSeconds: 2.15 },
    ])
    expect(slice.musicFadeOutAtSeconds).toBe(6)
  })
})

describe('editing and re-cutting a shorter version (review I2, I4, M3)', () => {
  it('cutdown on a shorter version at its own length returns its saved plan to edit, re-checked onto the same id', async () => {
    const { deps, store } = fakeDeps()
    const id = await seedOriginal(deps)
    const first = await runPlanTvc({ action: 'check', plan: ready(await draftOf(deps, id)) }, deps)
    const out = await runPlanTvc({ action: 'cutdown', planFileId: first.planFileId, lengthSeconds: 6 }, deps)
    const parsed = JSON.parse(out.slice!) as { draft: TvcPlan; editing: string }
    expect(parsed.editing).toBe(first.planFileId)
    expect(parsed.draft).toEqual(store.get(first.planFileId!)!.plan)
    const edited = { ...parsed.draft, voiceover: [{ text: 'Bubbli. So cold.', startSeconds: 0.5 }] }
    const again = await runPlanTvc({ action: 'check', plan: edited, planFileId: first.planFileId }, deps)
    expect(again).toMatchObject({ planFileId: first.planFileId, errors: [] })
    expect(store.get(first.planFileId!)!.plan.voiceover[0].text).toBe('Bubbli. So cold.')
  })
  it('a new length asked of a shorter version is cut from its original', async () => {
    const { deps } = fakeDeps()
    const id = await seedOriginal(deps)
    // A stand-in shorter version at 15s, so a 6s request is a different length.
    const fake = (await deps.save({ version: 1, storageKey: 'generated/conv/fake-cut.json', plan: { ...original15(), cutdownOf: { planFileId: id } } }))!
    const out = await runPlanTvc({ action: 'cutdown', planFileId: fake, lengthSeconds: 6 }, deps)
    expect(out.refused).toBeUndefined()
    expect((JSON.parse(out.slice!) as { draft: TvcPlan }).draft.cutdownOf).toEqual({ planFileId: id })
  })
  it('refuses a shots slice and a still on a shorter version, but records a re-trimmed clip', async () => {
    const { deps } = fakeDeps()
    const id = await seedOriginal(deps)
    const first = await runPlanTvc({ action: 'check', plan: ready(await draftOf(deps, id)) }, deps)
    const reason = 'CUTDOWN_REDO_ON_ORIGINAL: this is a shorter version cut from the original ad; change the moment on the original ad, then make the shorter version again'
    expect(await runPlanTvc({ action: 'get', planFileId: first.planFileId, slice: 'shots 1-1' }, deps)).toEqual({ refused: true, refusalReason: reason })
    expect(await runPlanTvc({ action: 'record', planFileId: first.planFileId, records: [{ shot: 1, stillFileId: 'st' }] }, deps)).toEqual({ refused: true, refusalReason: reason })
    expect((await runPlanTvc({ action: 'record', planFileId: first.planFileId, records: [{ shot: 1, clipFileId: 't1' }] }, deps)).refused).toBeUndefined()
  })
  it('a re-check can\'t turn one shorter version into another length', async () => {
    const { deps } = fakeDeps()
    const id = await seedOriginal(deps)
    const fake = (await deps.save({ version: 1, storageKey: 'generated/conv/fake-cut.json', plan: { ...original15(), cutdownOf: { planFileId: id } } }))!
    const out = await runPlanTvc({ action: 'check', plan: ready(await draftOf(deps, id)), planFileId: fake }, deps)
    expect(out.refusalReason).toBe('CUTDOWN_CHANGED: this plan is the 15s shorter version; a 6s one is a new plan: make it with plan_tvc cutdown and check it without planFileId')
  })
})
