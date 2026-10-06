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

function fakeDeps(opts: { slow?: boolean; checked?: string[]; detectCutTimes?: PlanTvcDeps['detectCutTimes']; productPhotoMimeType?: PlanTvcDeps['productPhotoMimeType'] } = {}) {
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
    detectCutTimes: opts.detectCutTimes ?? (async () => { throw new Error('detectCutTimes not expected in this test') }),
    productPhotoMimeType: opts.productPhotoMimeType ?? (async () => 'image/jpeg'),
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

describe('runPlanTvc check: reference cut times come from the file, not Director (Task 4)', () => {
  it('refuses cutTimes given without a videoFileId', async () => {
    const { deps } = fakeDeps()
    const p = plan(); p.brief.reference = { cutTimes: [2, 4] }
    const out = await runPlanTvc({ action: 'check', plan: p }, deps)
    expect(out.refusalReason).toMatch(/^REFERENCE_VIDEO_MISSING/)
  })
  it('overwrites Director\'s cutTimes with what detection returns, so an edited count still fails (the 13-vs-7 case)', async () => {
    const { deps } = fakeDeps({ detectCutTimes: async () => ({ cutTimes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], durationSeconds: 15 }) })
    const p = plan()
    // Director rewrote cutTimes to 2 to match its 2-boundary plan — detection
    // must overwrite it with the real 13 cuts, which this plan cannot match.
    p.brief.reference = { videoFileId: 'ref-video', cutTimes: [2] }
    const out = await runPlanTvc({ action: 'check', plan: p }, deps)
    expect(out.errors?.join(' ')).toMatch(/the reference has \d+ cuts in \d+s; this plan has \d+/)
  })
  it('refuses when detection fails, never falling back to the plan\'s own cutTimes', async () => {
    const { deps } = fakeDeps({ detectCutTimes: async () => { throw new Error('ffmpeg failed') } })
    const p = plan(); p.brief.reference = { videoFileId: 'ref-video' }
    const out = await runPlanTvc({ action: 'check', plan: p }, deps)
    expect(out.refusalReason).toMatch(/^REFERENCE_CUTS_UNAVAILABLE/)
  })
  it('a valid videoFileId with matching real cuts passes', async () => {
    const { deps } = fakeDeps({ detectCutTimes: async () => ({ cutTimes: [2, 4], durationSeconds: 6 }) })
    const p = plan(); p.brief.reference = { videoFileId: 'ref-video' }
    const out = await runPlanTvc({ action: 'check', plan: p }, deps)
    expect(out.errors).toEqual([])
  })
  it('refuses a zero or non-finite durationSeconds as unavailable, e.g. ffprobe on an image returning N/A', async () => {
    const zero = fakeDeps({ detectCutTimes: async () => ({ cutTimes: [2, 4], durationSeconds: 0 }) })
    const p1 = plan(); p1.brief.reference = { videoFileId: 'ref-video' }
    expect((await runPlanTvc({ action: 'check', plan: p1 }, zero.deps)).refusalReason).toMatch(/^REFERENCE_CUTS_UNAVAILABLE/)
    const nan = fakeDeps({ detectCutTimes: async () => ({ cutTimes: [2, 4], durationSeconds: NaN }) })
    const p2 = plan(); p2.brief.reference = { videoFileId: 'ref-video' }
    expect((await runPlanTvc({ action: 'check', plan: p2 }, nan.deps)).refusalReason).toMatch(/^REFERENCE_CUTS_UNAVAILABLE/)
  })
  it('refuses a re-check that drops or swaps the previously planned reference video', async () => {
    const { deps } = fakeDeps({ detectCutTimes: async () => ({ cutTimes: [2, 4], durationSeconds: 6 }) })
    const first = plan(); first.brief.reference = { videoFileId: 'ref-video-a' }
    const { planFileId } = await runPlanTvc({ action: 'check', plan: first }, deps)

    const dropped = plan() // no reference at all
    const droppedOut = await runPlanTvc({ action: 'check', plan: dropped, planFileId }, deps)
    expect(droppedOut.refusalReason).toMatch(/^REFERENCE_CHANGED: keep brief\.reference\.videoFileId ref-video-a/)

    const swapped = plan(); swapped.brief.reference = { videoFileId: 'ref-video-b' }
    const swappedOut = await runPlanTvc({ action: 'check', plan: swapped, planFileId }, deps)
    expect(swappedOut.refusalReason).toMatch(/^REFERENCE_CHANGED: keep brief\.reference\.videoFileId ref-video-a/)

    // Re-checking with the same reference video still works.
    const same = plan(); same.brief.reference = { videoFileId: 'ref-video-a' }
    const sameOut = await runPlanTvc({ action: 'check', plan: same, planFileId }, deps)
    expect(sameOut.errors).toEqual([])
  })
})

describe('runPlanTvc check: product photo must be an image, never the reference (Task 1)', () => {
  it('refuses a video mime type', async () => {
    const { deps } = fakeDeps({ productPhotoMimeType: async () => 'video/mp4' })
    const out = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect(out.refusalReason).toMatch(/^PRODUCT_PHOTO_NOT_IMAGE/)
  })
  it('refuses when productPhotoFileId is the reference video, before even checking its mime type', async () => {
    const { deps } = fakeDeps({ productPhotoMimeType: async () => { throw new Error('should not be called') } })
    const p = plan(); p.brief.productPhotoFileId = 'ref-video'; p.brief.reference = { videoFileId: 'ref-video' }
    const out = await runPlanTvc({ action: 'check', plan: p }, deps)
    expect(out.refusalReason).toMatch(/^PRODUCT_PHOTO_NOT_IMAGE/)
  })
  it('passes a real image', async () => {
    const { deps } = fakeDeps({ productPhotoMimeType: async () => 'image/png' })
    const out = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect(out.errors).toEqual([])
  })
  it('refuses, never passing silently, when the mime lookup itself fails', async () => {
    const { deps } = fakeDeps({ productPhotoMimeType: async () => { throw new Error('file lookup failed') } })
    const out = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect(out.refusalReason).toBe('PRODUCT_PHOTO_UNCHECKED: could not read the product photo; try again')
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
