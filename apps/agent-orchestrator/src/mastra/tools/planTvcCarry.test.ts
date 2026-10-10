import { describe, it, expect, vi } from 'vitest'
vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl: vi.fn() }))
import { runPlanTvc, type PlanTvcDeps, type SavedPlan } from './planTvc.js'
import { tvcPlanSchema, type TvcPlan } from './tvcPlan.js'

const plan = (): TvcPlan => tvcPlanSchema.parse({
  brief: { message: 'Ice cold refreshment', category: 'beverage', tier: 'mass', objective: 'brand', market: 'generic', lengthSeconds: 6, aspectRatio: '16:9', productPhotoFileId: 'prod', voiceId: 'v1' },
  look: 'bright, deep focus', locations: ['school corridor'],
  shots: [
    { n: 1, type: 'product_macro', size: 'extreme_close_up', action: 'bottle drops into the slot', durationSeconds: 2, brandVisible: true, productVisible: true, audio: 'voiceover', text: 'Ice cold' },
    // brandVisible on shot 2 too, so the reorder test still shows the brand before 2.0s.
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
  const recheck = async (q: TvcPlan) => {
    const out = await runPlanTvc({ action: 'check', plan: q, planFileId }, deps)
    return { out, saved: store.get(planFileId!)!.plan }
  }
  return { recheck }
}

describe('R2: stills survive edits that do not change the picture', () => {
  it('a length swap keeps every still, keeps the narration, and drops only the changed shots\' clips', async () => {
    const { recheck } = await recorded()
    const q = plan(); q.shots[0].durationSeconds = 1.5; q.shots[1].durationSeconds = 2.5
    const { out, saved } = await recheck(q)
    expect(out.errors).toEqual([])
    expect(saved.shots.map((s) => s.stillFileId)).toEqual(['s1', 's2', 's3'])
    expect(saved.shots.map((s) => s.clipFileId)).toEqual([undefined, undefined, undefined])
    expect(saved.narrationFileIds).toEqual(['n1'])
    expect(out.warnings ?? []).not.toEqual(expect.arrayContaining([expect.stringMatching(/^NARRATION_REMAKE/)]))
  })
  it('a text edit keeps the still and the clip', async () => {
    const { recheck } = await recorded()
    const q = plan(); q.shots[0].text = 'So cold'
    const { saved } = await recheck(q)
    expect(saved.shots[0]).toMatchObject({ stillFileId: 's1', clipFileId: 'c1' })
  })
  it('a reorder keeps the stills by what each shot shows, and drops the moved clips', async () => {
    const { recheck } = await recorded()
    const q = plan(); const [a, b] = [q.shots[0], q.shots[1]]
    q.shots[0] = { ...b, n: 1 }; q.shots[1] = { ...a, n: 2 }
    const { out, saved } = await recheck(q)
    expect(out.errors).toEqual([])
    expect(saved.shots.map((s) => s.stillFileId)).toEqual(['s2', 's1', 's3'])
    expect(saved.shots[0].clipFileId).toBeUndefined()
    expect(saved.shots[1].clipFileId).toBeUndefined()
  })
  it('a changed action still drops that shot\'s still and clip', async () => {
    const { recheck } = await recorded()
    const q = plan(); q.shots[1].action = 'snow sweeps the corridor'
    const { saved } = await recheck(q)
    expect(saved.shots[1].stillFileId).toBeUndefined()
    expect(saved.shots[1].clipFileId).toBeUndefined()
    expect(saved.shots[0]).toMatchObject({ stillFileId: 's1', clipFileId: 'c1' })
  })
})

describe('R7: narration ignores where a block starts; dropped audio is warned about', () => {
  it('a moved block keeps its narration', async () => {
    const { recheck } = await recorded()
    const q = plan(); q.voiceover[0].startSeconds = 0.8
    expect((await recheck(q)).saved.narrationFileIds).toEqual(['n1'])
  })
  it('a changed line drops the narration with a warning; a tier change drops the bed with a warning', async () => {
    const { recheck } = await recorded()
    const q = plan(); q.voiceover[0].text = 'So cold.'
    const a = await recheck(q)
    expect(a.saved.narrationFileIds).toBeUndefined()
    expect(a.out.warnings).toContain('NARRATION_REMAKE: the voiceover changed, so its narration will be made again (paid)')
    const r = plan(); r.voiceover[0].text = 'So cold.'; r.brief.tier = 'premium'
    expect((await recheck(r)).out.warnings).toContain('MUSIC_REMAKE: the tier or category changed, so the music bed will be made again (paid)')
  })
  it('nothing recorded means nothing to warn about', async () => {
    const { deps } = fakeDeps()
    const { planFileId } = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    const q = plan(); q.voiceover[0].text = 'So cold.'
    const out = await runPlanTvc({ action: 'check', plan: q, planFileId }, deps)
    expect((out.warnings ?? []).filter((w) => /_REMAKE:/.test(w))).toEqual([])
  })
})
