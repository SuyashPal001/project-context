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

const tick = () => new Promise((r) => setTimeout(r, 5))

function fakeDeps(opts: { slow?: boolean; checked?: string[] } = {}) {
  const store = new Map<string, SavedPlan>()
  const keyToId = new Map<string, string>()
  let n = 0
  const deps: PlanTvcDeps = {
    load: async (id) => { if (opts.slow) await tick(); const doc = store.get(id); if (!doc) throw new Error('missing'); return structuredClone(doc) },
    save: async (doc) => {
      if (opts.slow) await tick()
      const id = keyToId.get(doc.storageKey) ?? `file-${++n}`
      keyToId.set(doc.storageKey, id); store.set(id, structuredClone(doc)); return id
    },
    price: async () => ({ fullCostCredits: 42, shortfallCredits: 0 }),
    newKey: () => `generated/conv/tvc-plan-${n + 1}.json`,
    stillChecked: (id) => (opts.checked ? opts.checked.includes(id) : true),
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

describe('runPlanTvc record — several shots, narration and song', () => {
  const getFinish = async (deps: PlanTvcDeps, id: string) => JSON.parse((await runPlanTvc({ action: 'get', planFileId: id, slice: 'finish' }, deps)).slice!)
  it('records a whole step in one call; the single-shot form still works', async () => {
    const { deps } = fakeDeps()
    const { planFileId } = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    await runPlanTvc({ action: 'record', planFileId: planFileId!, records: [{ shot: 1, clipFileId: 'c1' }, { shot: 2, clipFileId: 'c2' }] }, deps)
    await runPlanTvc({ action: 'record', planFileId: planFileId!, shot: 3, clipFileId: 'c3' }, deps)
    expect((await getFinish(deps, planFileId!)).shots.map((s: { clipFileId?: string }) => s.clipFileId)).toEqual(['c1', 'c2', 'c3'])
  })
  it('records nothing when one of the shots does not exist', async () => {
    const { deps } = fakeDeps()
    const { planFileId } = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    const out = await runPlanTvc({ action: 'record', planFileId: planFileId!, records: [{ shot: 1, clipFileId: 'c1' }, { shot: 9, clipFileId: 'c9' }] }, deps)
    expect(out.refusalReason).toBe('NO_SUCH_SHOT')
    expect((await getFinish(deps, planFileId!)).shots[0].clipFileId).toBeUndefined()
  })
  it('stores the narration and the song, and the finish slice returns them', async () => {
    const { deps } = fakeDeps()
    const withVo = plan(); withVo.voiceover = [{ text: 'Ice cold.', startSeconds: 0.5 }]
    const { planFileId } = await runPlanTvc({ action: 'check', plan: withVo }, deps)
    expect((await runPlanTvc({ action: 'record', planFileId: planFileId!, narrationFileIds: ['n1'], songFileId: 'song1' }, deps)).planFileId).toBe(planFileId)
    expect(await getFinish(deps, planFileId!)).toMatchObject({ narrationFileIds: ['n1'], songFileId: 'song1' })
  })
  it('refuses narration that does not match the voiceover blocks one for one', async () => {
    const { deps } = fakeDeps()
    const { planFileId } = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect((await runPlanTvc({ action: 'record', planFileId: planFileId!, narrationFileIds: ['n1'] }, deps)).refusalReason).toBe('NARRATION_COUNT_MISMATCH')
  })
  it('refuses a record with nothing to record', async () => {
    const { deps } = fakeDeps()
    const { planFileId } = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect((await runPlanTvc({ action: 'record', planFileId: planFileId! }, deps)).refusalReason).toBe('NOTHING_TO_RECORD')
  })
})

describe('runPlanTvc re-check keeps or clears the saved narration and song', () => {
  async function setup() {
    const { deps } = fakeDeps()
    const p = plan(); p.voiceover = [{ text: 'Ice cold.', startSeconds: 0.5 }]
    const { planFileId } = await runPlanTvc({ action: 'check', plan: p }, deps)
    await runPlanTvc({ action: 'record', planFileId: planFileId!, narrationFileIds: ['n1'], songFileId: 'song1' }, deps)
    const recheck = async (mutate: (q: ReturnType<typeof plan>) => void) => {
      const q = plan(); q.voiceover = [{ text: 'Ice cold.', startSeconds: 0.5 }]; mutate(q)
      await runPlanTvc({ action: 'check', plan: q, planFileId }, deps)
      return JSON.parse((await runPlanTvc({ action: 'get', planFileId: planFileId!, slice: 'finish' }, deps)).slice!)
    }
    return recheck
  }
  it('keeps both when the voiceover, voice, tier and category are unchanged', async () => {
    const recheck = await setup()
    expect(await recheck((q) => { q.shots[1].action = 'snow sweeps the corridor' })).toMatchObject({ narrationFileIds: ['n1'], songFileId: 'song1' })
  })
  it('clears the narration when the voiceover or the voice changes, and keeps the song', async () => {
    const text = await (await setup())((q) => { q.voiceover[0].text = 'So cold.' })
    expect(text.narrationFileIds).toBeUndefined()
    expect(text.songFileId).toBe('song1')
    expect((await (await setup())((q) => { q.voiceover[0].startSeconds = 0.8 })).narrationFileIds).toBeUndefined()
    expect((await (await setup())((q) => { q.brief.voiceId = 'other-voice' })).narrationFileIds).toBeUndefined()
  })
  it('clears the song when the tier or the category changes, and keeps the narration', async () => {
    const tier = await (await setup())((q) => { q.brief.tier = 'premium' })
    expect(tier.songFileId).toBeUndefined()
    expect(tier.narrationFileIds).toEqual(['n1'])
    expect((await (await setup())((q) => { q.brief.category = 'food' })).songFileId).toBeUndefined()
  })
})

describe('record refuses unchecked stills (spec 3.3)', () => {
  it('STILL_NOT_CHECKED unless check_still passed or the user kept it', async () => {
    const { deps } = fakeDeps({ checked: ['ok1'] })
    const { planFileId } = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect((await runPlanTvc({ action: 'record', planFileId: planFileId!, records: [{ shot: 1, stillFileId: 'bad1' }] }, deps)).refusalReason).toMatch(/^STILL_NOT_CHECKED/)
    expect((await runPlanTvc({ action: 'record', planFileId: planFileId!, records: [{ shot: 1, stillFileId: 'ok1' }] }, deps)).refused).toBeUndefined()
    expect((await runPlanTvc({ action: 'record', planFileId: planFileId!, records: [{ shot: 2, stillFileId: 'bad2', keptByUser: true }] }, deps)).refused).toBeUndefined()
  })
  it('a continuing shot takes no still', async () => {
    const { deps } = fakeDeps()
    const p = plan()
    p.shots[1].continuesFrom = 1
    p.shots[1].location = p.shots[0].location
    p.shots[1].size = 'close_up'
    p.shots[2].size = 'medium'
    const { planFileId, errors } = await runPlanTvc({ action: 'check', plan: p }, deps)
    expect(errors).toEqual([])
    expect((await runPlanTvc({ action: 'record', planFileId: planFileId!, records: [{ shot: 2, stillFileId: 's2' }] }, deps)).refusalReason).toMatch(/^CONTINUING_SHOT_HAS_NO_STILL/)
  })
  it('a still on a nonexistent shot gets NO_SUCH_SHOT, not STILL_NOT_CHECKED', async () => {
    const { deps } = fakeDeps()
    const { planFileId } = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect((await runPlanTvc({ action: 'record', planFileId: planFileId!, records: [{ shot: 9, stillFileId: 'bad' }] }, deps)).refusalReason).toBe('NO_SUCH_SHOT')
  })
})

describe('runPlanTvc lock', () => {
  it('two records on the same plan at once both survive', async () => {
    const { deps } = fakeDeps({ slow: true })
    const { planFileId } = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    await Promise.all([
      runPlanTvc({ action: 'record', planFileId: planFileId!, shot: 1, stillFileId: 's1' }, deps),
      runPlanTvc({ action: 'record', planFileId: planFileId!, shot: 2, stillFileId: 's2' }, deps),
      runPlanTvc({ action: 'record', planFileId: planFileId!, songFileId: 'song1' }, deps),
    ])
    const slice = JSON.parse((await runPlanTvc({ action: 'get', planFileId: planFileId!, slice: 'shots 1-2' }, deps)).slice!)
    expect(slice.shots.map((s: { stillFileId?: string }) => s.stillFileId)).toEqual(['s1', 's2'])
    expect(JSON.parse((await runPlanTvc({ action: 'get', planFileId: planFileId!, slice: 'finish' }, deps)).slice!).songFileId).toBe('song1')
  })
  it('a failed record does not block the next one', async () => {
    const { deps } = fakeDeps({ slow: true })
    const { planFileId } = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    const [bad, good] = await Promise.all([
      runPlanTvc({ action: 'record', planFileId: 'missing-plan', shot: 1, stillFileId: 'x' }, deps).catch((e: Error) => e.message),
      runPlanTvc({ action: 'record', planFileId: planFileId!, shot: 1, stillFileId: 's1' }, deps),
    ])
    expect(bad).toBe('missing')
    expect((good as { planFileId?: string }).planFileId).toBe(planFileId)
  })
})

describe('plan_tvc record: the jingle (J5)', () => {
  const withJingle = () => { const p = plan(); p.brief.jingle = { line: 'Ice cold, every time', style: 'bright pop, male vocal' }; return p }
  const getFinish = async (deps: PlanTvcDeps, id: string) => JSON.parse((await runPlanTvc({ action: 'get', planFileId: id, slice: 'finish' }, deps)).slice!)

  it('records the jingle and the finish slice returns it with its timing', async () => {
    const { deps } = fakeDeps()
    const { planFileId } = await runPlanTvc({ action: 'check', plan: withJingle() }, deps)
    expect(await runPlanTvc({ action: 'record', planFileId: planFileId!, jingleFileId: 'j1', signoffFileId: 's1', signoffSeconds: 2 }, deps)).toEqual({ planFileId })
    expect(await getFinish(deps, planFileId!)).toMatchObject({ jingleFileId: 'j1', signoffFileId: 's1', signoffSeconds: 2, signoffStartSeconds: 4, musicFadeOutAtSeconds: 3.7 })
  })
  it('refuses JINGLE_TOO_LONG and saves nothing', async () => {
    const { deps } = fakeDeps()
    const { planFileId } = await runPlanTvc({ action: 'check', plan: withJingle() }, deps)
    const out = await runPlanTvc({ action: 'record', planFileId: planFileId!, jingleFileId: 'j1', signoffFileId: 's1', signoffSeconds: 4.5 }, deps)
    expect(out).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^JINGLE_TOO_LONG/) })
    expect((await getFinish(deps, planFileId!)).jingleFileId).toBeUndefined()
  })
  it('refuses a partial jingle record, and a jingle on a plan without one', async () => {
    const { deps } = fakeDeps()
    const a = await runPlanTvc({ action: 'check', plan: withJingle() }, deps)
    expect(await runPlanTvc({ action: 'record', planFileId: a.planFileId!, jingleFileId: 'j1' }, deps)).toMatchObject({ refusalReason: expect.stringMatching(/^JINGLE_RECORD_INCOMPLETE/) })
    const b = await runPlanTvc({ action: 'check', plan: plan() }, fakeDeps().deps)
    const { deps: d2 } = fakeDeps()
    const c = await runPlanTvc({ action: 'check', plan: plan() }, d2)
    expect(b.planFileId).toBeDefined()
    expect(await runPlanTvc({ action: 'record', planFileId: c.planFileId!, jingleFileId: 'j1', signoffFileId: 's1', signoffSeconds: 2 }, d2)).toMatchObject({ refusalReason: expect.stringMatching(/^NO_JINGLE_IN_PLAN/) })
  })
  it('a re-check keeps the recorded jingle while the jingle is the same, and drops it when the line changes', async () => {
    const { deps } = fakeDeps()
    const { planFileId } = await runPlanTvc({ action: 'check', plan: withJingle() }, deps)
    await runPlanTvc({ action: 'record', planFileId: planFileId!, jingleFileId: 'j1', signoffFileId: 's1', signoffSeconds: 2 }, deps)
    await runPlanTvc({ action: 'check', plan: withJingle(), planFileId }, deps)
    expect((await getFinish(deps, planFileId!)).jingleFileId).toBe('j1')
    const changed = withJingle(); changed.brief.jingle!.line = 'Ice cold, always'
    await runPlanTvc({ action: 'check', plan: changed, planFileId }, deps)
    const finish = await getFinish(deps, planFileId!)
    expect(finish.jingleFileId).toBeUndefined()
    expect(finish.signoffStartSeconds).toBeUndefined()
  })
  // F4: the comparison is field by field, so a different key order on the
  // jingle object still counts as the same jingle.
  it('a re-check keeps the recorded jingle when the jingle object arrives with its keys in a different order', async () => {
    const { deps } = fakeDeps()
    const { planFileId } = await runPlanTvc({ action: 'check', plan: withJingle() }, deps)
    await runPlanTvc({ action: 'record', planFileId: planFileId!, jingleFileId: 'j1', signoffFileId: 's1', signoffSeconds: 2 }, deps)
    const reordered = withJingle()
    reordered.brief.jingle = { style: 'bright pop, male vocal', line: 'Ice cold, every time' }
    await runPlanTvc({ action: 'check', plan: reordered, planFileId }, deps)
    const finish = await getFinish(deps, planFileId!)
    expect(finish.jingleFileId).toBe('j1')
    expect(finish.signoffStartSeconds).toBe(4)
  })
  it('a fresh check saves none of the three jingle fields, even when the input plan carries them', async () => {
    const { deps } = fakeDeps()
    const p = withJingle()
    p.jingleFileId = 'sneaky'; p.signoffFileId = 'sneaky'; p.signoffSeconds = 100
    const { planFileId } = await runPlanTvc({ action: 'check', plan: p }, deps)
    const finish = await getFinish(deps, planFileId!)
    expect(finish.jingleFileId).toBeUndefined()
    expect(finish.signoffFileId).toBeUndefined()
    expect(finish.signoffSeconds).toBeUndefined()
    expect(finish.signoffStartSeconds).toBeUndefined()
  })
})

describe('plan_tvc record: async still records (K1)', () => {
  it('awaits an async stillChecked and refuses an unchecked still', async () => {
    const { deps } = fakeDeps()
    deps.stillChecked = async (id) => id === 'good'
    const { planFileId } = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect(await runPlanTvc({ action: 'record', planFileId: planFileId!, shot: 1, stillFileId: 'bad' }, deps)).toMatchObject({ refusalReason: expect.stringMatching(/^STILL_NOT_CHECKED/) })
    expect(await runPlanTvc({ action: 'record', planFileId: planFileId!, shot: 1, stillFileId: 'good' }, deps)).toEqual({ planFileId })
  })
})
