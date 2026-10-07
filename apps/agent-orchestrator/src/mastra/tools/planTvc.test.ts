import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl: vi.fn() }))

import { runPlanTvc, planTvc, resolveProductPhotoInfo, isExtractedFramePath, type PlanTvcDeps, type SavedPlan } from './planTvc.js'
import { fetchPresignedUrl } from './mediaCache.js'
import { tvcPlanSchema } from './tvcPlan.js'
import { extractFrameKey } from './extractFrame.js'
import { generatedFileKey } from '../../persistence.js'

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

function fakeDeps(opts: { slow?: boolean; checked?: string[]; detectCutTimes?: PlanTvcDeps['detectCutTimes']; productPhotoInfo?: PlanTvcDeps['productPhotoInfo'] } = {}) {
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
    productPhotoInfo: opts.productPhotoInfo ?? (async () => ({ mimeType: 'image/jpeg', pathname: '/generated/conv1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-product-photo.jpg' })),
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

  // F3: once a reference is planned, lengthSeconds is locked the same way
  // the reference video itself is.
  it('refuses a re-check that changes lengthSeconds once a reference is planned', async () => {
    const { deps } = fakeDeps({ detectCutTimes: async () => ({ cutTimes: [2, 4], durationSeconds: 6 }) })
    const first = plan(); first.brief.reference = { videoFileId: 'ref-video-a' }
    const { planFileId } = await runPlanTvc({ action: 'check', plan: first }, deps)

    const changed = plan(); changed.brief.reference = { videoFileId: 'ref-video-a' }; changed.brief.lengthSeconds = 15
    const out = await runPlanTvc({ action: 'check', plan: changed, planFileId }, deps)
    expect(out.refusalReason).toMatch(/^LENGTH_CHANGED: keep brief\.lengthSeconds 6/)
  })
  it('allows a lengthSeconds change on a re-check with no reference planned', async () => {
    const { deps } = fakeDeps()
    const first = plan()
    const { planFileId } = await runPlanTvc({ action: 'check', plan: first }, deps)

    const changed = plan(); changed.brief.lengthSeconds = 15
    const out = await runPlanTvc({ action: 'check', plan: changed, planFileId }, deps)
    expect(out.refusalReason).toBeUndefined()
  })
})

describe('runPlanTvc check: the reference video comes from Olmo\'s delegation (F4)', () => {
  it('refuses a first check whose brief disagrees with the delegation-carried reference', async () => {
    const { deps } = fakeDeps()
    deps.expectedReferenceVideoFileId = 'file-ref-99'
    const out = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect(out.refusalReason).toMatch(/^REFERENCE_VIDEO_MISSING: this ad recreates a reference; set brief\.reference\.videoFileId to file-ref-99/)
  })
  it('passes a first check whose brief.reference.videoFileId matches', async () => {
    const { deps } = fakeDeps({ detectCutTimes: async () => ({ cutTimes: [2, 4], durationSeconds: 6 }) })
    deps.expectedReferenceVideoFileId = 'file-ref-99'
    const p = plan(); p.brief.reference = { videoFileId: 'file-ref-99' }
    const out = await runPlanTvc({ action: 'check', plan: p }, deps)
    expect(out.errors).toEqual([])
  })
  it('does not refuse when no reference was carried by the delegation', async () => {
    const { deps } = fakeDeps()
    const out = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect(out.refusalReason).toBeUndefined()
  })
})

describe('runPlanTvc check: product photo must be an image, never the reference (Task 1)', () => {
  it('refuses a video mime type', async () => {
    const { deps } = fakeDeps({ productPhotoInfo: async () => ({ mimeType: 'video/mp4', pathname: '/generated/conv1/x-video.mp4' }) })
    const out = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect(out.refusalReason).toMatch(/^PRODUCT_PHOTO_NOT_IMAGE/)
  })
  it('refuses when productPhotoFileId is the reference video, before even checking its mime type', async () => {
    const { deps } = fakeDeps({ productPhotoInfo: async () => { throw new Error('should not be called') } })
    const p = plan(); p.brief.productPhotoFileId = 'ref-video'; p.brief.reference = { videoFileId: 'ref-video' }
    const out = await runPlanTvc({ action: 'check', plan: p }, deps)
    expect(out.refusalReason).toMatch(/^PRODUCT_PHOTO_NOT_IMAGE/)
  })
  it('passes a real image', async () => {
    const { deps } = fakeDeps({ productPhotoInfo: async () => ({ mimeType: 'image/png', pathname: '/generated/conv1/x-product-photo.png' }) })
    const out = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect(out.errors).toEqual([])
  })
  it('refuses, never passing silently, when the mime lookup itself fails', async () => {
    const { deps } = fakeDeps({ productPhotoInfo: async () => { throw new Error('file lookup failed') } })
    const out = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect(out.refusalReason).toBe('PRODUCT_PHOTO_UNCHECKED: could not read the product photo; try again')
  })

  // F1: some browser uploads land in S3 under a generic mime type
  // (apps/web/lib/assetType.ts:7-9) instead of the real one — a real photo
  // must still pass when its storage path says it's an image.
  it('accepts an octet-stream upload whose pathname ends in a real image extension', async () => {
    const { deps } = fakeDeps({ productPhotoInfo: async () => ({ mimeType: 'application/octet-stream', pathname: '/generated/conv1/x-product-photo.jpg' }) })
    const out = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect(out.errors).toEqual([])
  })
  it('accepts binary/octet-stream and an empty mime the same way, case-insensitively', async () => {
    for (const mimeType of ['binary/octet-stream', '', 'APPLICATION/OCTET-STREAM']) {
      const { deps } = fakeDeps({ productPhotoInfo: async () => ({ mimeType, pathname: '/generated/conv1/x-product-photo.WEBP' }) })
      const out = await runPlanTvc({ action: 'check', plan: plan() }, deps)
      expect(out.errors).toEqual([])
    }
  })
  it('still refuses an octet-stream upload whose pathname is not an image, e.g. a video', async () => {
    const { deps } = fakeDeps({ productPhotoInfo: async () => ({ mimeType: 'application/octet-stream', pathname: '/generated/conv1/x-product-video.mp4' }) })
    const out = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect(out.refusalReason).toMatch(/^PRODUCT_PHOTO_NOT_IMAGE/)
  })
})

describe('runPlanTvc check: the product photo can never be a frame pulled from a video (Task 2)', () => {
  it('refuses a product photo produced by extract_frame', async () => {
    const pathname = `/${extractFrameKey('conv1', 'Bubbli Last Frame')}`
    const { deps } = fakeDeps({ productPhotoInfo: async () => ({ mimeType: 'image/jpeg', pathname }) })
    const out = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect(out.refusalReason).toMatch(/^PRODUCT_PHOTO_FROM_REFERENCE/)
  })
  it('passes a real image that was not extracted from any video', async () => {
    const { deps } = fakeDeps({ productPhotoInfo: async () => ({ mimeType: 'image/jpeg', pathname: '/generated/conv1/abc-product-photo.jpg' }) })
    const out = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect(out.errors).toEqual([])
  })
  it('refuses, never passing silently, when the origin lookup itself fails', async () => {
    const { deps } = fakeDeps({ productPhotoInfo: async () => { throw new Error('lookup failed') } })
    const out = await runPlanTvc({ action: 'check', plan: plan() }, deps)
    expect(out.refusalReason).toBe('PRODUCT_PHOTO_UNCHECKED: could not read the product photo; try again')
  })
})

// Task 2 review fix: isExtractedFramePath is anchored on a 36-char uuid-shaped
// segment immediately before the marker, not a bare substring search — a
// bare `includes('-extract-frame-')` missed a title that slugs to nothing
// (generatedFileKey trims the trailing hyphen down to "<uuid>-extract-frame.jpg")
// and would also false-positive on an unrelated file whose name merely
// contains the phrase.
describe('isExtractedFramePath: recognises extract_frame\'s own key marker, anchored on the uuid (Task 2 review fix)', () => {
  it('is true for a title that slugs to nothing — Hindi — where the trailing hyphen is trimmed away', () => {
    expect(isExtractedFramePath(`/${extractFrameKey('conv1', 'उत्पाद फ्रेम')}`)).toBe(true)
  })
  it('is true for a punctuation-only title, for the same reason', () => {
    expect(isExtractedFramePath(`/${extractFrameKey('conv1', '!!!')}`)).toBe(true)
  })
  it('is true for an ordinary title (the slug survives, with a trailing hyphen before it)', () => {
    expect(isExtractedFramePath(`/${extractFrameKey('conv1', 'Bubbli Product Photo Frame')}`)).toBe(true)
  })
  it('is false for a generated image whose title merely contains the phrase (no uuid immediately before it)', () => {
    const key = generatedFileKey('conv1', 'Bubbli extract frame shot', 'jpg')
    expect(isExtractedFramePath(`/${key}`)).toBe(false)
  })
  it('is false for a plain user upload named with the phrase', () => {
    expect(isExtractedFramePath('/t1/11111111-1111-4111-8111-111111111111/my-extract-frame-photo.jpg')).toBe(false)
  })
})

describe('resolveProductPhotoInfo: the real dep strips x-amz-checksum-mode before fetching, and returns the path untouched (Task 1 + Task 2 review fix)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetches the presigned URL with x-amz-checksum-mode removed, cancels the body, and keeps the pathname', async () => {
    vi.mocked(fetchPresignedUrl).mockResolvedValue('https://bucket.s3.amazonaws.com/generated/conv1/k.png?X-Amz-Signature=s&x-amz-checksum-mode=ENABLED')
    const cancel = vi.fn()
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/png' },
      body: { cancel },
    }) as never

    const info = await resolveProductPhotoInfo('f1', 'tok')

    expect(info.mimeType).toBe('image/png')
    expect(info.pathname).toBe('/generated/conv1/k.png')
    expect((global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('https://bucket.s3.amazonaws.com/generated/conv1/k.png?X-Amz-Signature=s')
    expect(cancel).toHaveBeenCalled()
  })

  it('throws when the fetch fails, so the caller refuses rather than passing silently', async () => {
    vi.mocked(fetchPresignedUrl).mockResolvedValue('https://bucket.s3.amazonaws.com/k?X-Amz-Signature=s')
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as never
    await expect(resolveProductPhotoInfo('f1', 'tok')).rejects.toThrow(/403/)
  })

  // Only one presign lookup and one GET per check — not a second round trip
  // for the extracted-frame marker (Task 2 review fix: Minor 2).
  it('makes exactly one presigned-url call and one fetch', async () => {
    vi.mocked(fetchPresignedUrl).mockResolvedValue('https://bucket.s3.amazonaws.com/generated/conv1/k.png?X-Amz-Signature=s')
    global.fetch = vi.fn().mockResolvedValue({ ok: true, headers: { get: () => 'image/png' }, body: { cancel: vi.fn() } }) as never
    await resolveProductPhotoInfo('f1', 'tok')
    expect(vi.mocked(fetchPresignedUrl)).toHaveBeenCalledTimes(1)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })
})

// Task 2 review fix: Minor 3 — the production dep wiring (not just fakeDeps)
// must reach the real resolveProductPhotoInfo and refuse on its result.
describe('planTvc execute: the real productPhotoInfo wiring refuses an extracted-frame product photo (Task 2 review fix)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refuses PRODUCT_PHOTO_FROM_REFERENCE through the tool\'s actual execute, not a fake dep', async () => {
    const key = extractFrameKey('conv1', 'Bubbli Last Frame')
    vi.mocked(fetchPresignedUrl).mockResolvedValue(`https://bucket.s3.amazonaws.com/${key}?X-Amz-Signature=s`)
    global.fetch = vi.fn().mockResolvedValue({ ok: true, headers: { get: () => 'image/jpeg' }, body: { cancel: vi.fn() } }) as never
    const values: Record<string, unknown> = { idToken: 'tok', conversationId: 'conv1', tenantId: 't1' }
    const ctx = { requestContext: { get: (k: string) => values[k] } }
    const out = await (planTvc as unknown as { execute: (input: unknown, ctx: unknown) => Promise<{ refusalReason?: string }> }).execute({ action: 'check', plan: plan() }, ctx)
    expect(out.refusalReason).toMatch(/^PRODUCT_PHOTO_FROM_REFERENCE/)
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

describe('runPlanTvc check — disclaimers', () => {
  const TWO_LINES = 'Based on an independent lab test of moisture retention over eight hours. Results may vary.'
  it('refuses a 6 s ad whose 2-line disclaimer needs 8 s, and saves nothing (E3)', async () => {
    const { deps, store } = fakeDeps()
    const p = plan(); p.legal = [{ text: TWO_LINES, startSeconds: 0 }]
    const out = await runPlanTvc({ action: 'check', plan: p }, deps)
    expect(out.errors?.join(' ')).toMatch(/^LEGAL_HOLD_TOO_LONG: .* needs 8s on screen/)
    expect(store.size).toBe(0)
  })
  it('saves wholeAd with the computed times', async () => {
    const { deps, store } = fakeDeps()
    const p = plan(); p.legal = [{ text: TWO_LINES, wholeAd: true }]
    const out = await runPlanTvc({ action: 'check', plan: p }, deps)
    expect(out.errors).toEqual([])
    expect(store.get(out.planFileId!)!.plan.legal[0]).toMatchObject({ startSeconds: 0, endSeconds: 6 })
  })
})

describe('plan_tvc get finish — refuses rather than dropping a disclaimer (E7)', () => {
  it('refuses with the legalTimings errors instead of silently omitting the line', async () => {
    const { deps } = fakeDeps()
    const p = plan(); p.legal = [{ text: 'As per lab test. Results may vary.', forVoiceoverBlock: 1 }]
    const planFileId = await deps.save({ version: 1, storageKey: deps.newKey(), plan: p })
    const out = await runPlanTvc({ action: 'get', planFileId: planFileId!, slice: 'finish' }, deps)
    expect(out.refused).toBe(true)
    expect(out.refusalReason).toMatch(/^LEGAL_CLAIM_MISSING: legal line "As per lab test\. Results may vary\." points at voiceover block 1, which doesn't exist/)
  })
})
