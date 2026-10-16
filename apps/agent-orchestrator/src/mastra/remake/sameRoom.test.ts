// Same room across looks (fan reel on the real workflow, 2026-10-16): look 1 was drawn on a dark rug and
// looks 2-4 on a cream one, though the original never changes room. A later person still is checked
// against the first kept one (tools/sameSetting) when the original's own frames show the same place, and a
// different room is fixed by the one edit with the first still as the room to copy.
import { describe, it, expect, vi } from 'vitest'
import { makeStill, type StillCtx, type StillJob } from './paidStill.js'
import { remakeLooks } from './looks.js'
import type { RemakeDeps } from './deps.js'
import { breakdown } from './fixtures.testing.js'

const img = (d: string) => ({ data: d, mime: 'image/jpeg' })
const look = remakeLooks(breakdown())[0]
const ctx: StillCtx = { tenantId: 't', idToken: 'tok', scopeId: 's', runId: 'r', exec: () => ({ requestContext: { get: () => undefined }, agent: { toolCallId: 'remake:r' } }) as never, portrait: { fileId: 'sheet', img: img('P') } }
const job = (room?: StillJob['room']): StillJob => ({ look, kind: 'start', prompt: 'P', references: ['sheet', 'guide-2'], aspectRatio: '9:16', gate: { prompt: 'P', planLine: 'x', look: {}, startFrameObjects: [], keyMoments: [] }, ...(room ? { room } : {}) })
const deps = (sameSetting: RemakeDeps['sameSetting']) => {
  let n = 0
  return {
    ask: () => vi.fn(), fetchImage: vi.fn(async (id: string) => img(id)), localFile: vi.fn(async (id: string) => `/m/${id}`), upload: vi.fn(),
    generateStill: vi.fn(async () => ({ fileId: `still-${++n}`, creditsUsedMicro: '100' })),
    poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 1, no_person: false, main: look.start }),
    promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
    stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [], warnings: [] }),
    sameSetting,
  } as unknown as RemakeDeps
}

describe('a later still is kept in the first still\'s room', () => {
  it('a different room is fixed by editing it, with the first still as the room to copy', async () => {
    // original frames: same place; first try: different rug; the edit: same
    const same = vi.fn().mockResolvedValueOnce({ same: true, differs: '' }).mockResolvedValueOnce({ same: false, differs: 'dark grey rug, not the cream one' }).mockResolvedValue({ same: true, differs: '' })
    const d = deps(same)
    const r = await makeStill(job({ fileId: 'anchor', guides: ['guide-1', 'guide-2'] }), ctx, d)
    expect(r.result.status).toBe('passed')
    const edit = (d.generateStill as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(edit.referenceFileIds).toEqual(['still-1', 'sheet', 'anchor'])
    expect(edit.prompt).toMatch(/the setting must match image 3/)
  })
  it('no room check when the original itself changes place between the looks', async () => {
    const same = vi.fn().mockResolvedValue({ same: false, differs: 'platform vs inside the train' })
    const d = deps(same)
    const r = await makeStill(job({ fileId: 'anchor', guides: ['guide-1', 'guide-2'] }), ctx, d)
    expect(r.result.status).toBe('passed')
    expect(same).toHaveBeenCalledTimes(1) // only the original frames were compared
    expect(d.generateStill).toHaveBeenCalledTimes(1)
  })
  it('a room that can\'t be compared is a warning, never a pass in silence', async () => {
    const same = vi.fn().mockResolvedValueOnce({ same: true, differs: '' }).mockResolvedValue({ same: null, differs: '' })
    const r = await makeStill(job({ fileId: 'anchor', guides: ['guide-1', 'guide-2'] }), ctx, deps(same))
    expect(r.result.status).toBe('warned')
    expect(r.result.reasons.join(' ')).toMatch(/room could not be compared/)
  })
  it('the first still (no room given) is not compared', async () => {
    const same = vi.fn()
    await makeStill(job(), ctx, deps(same))
    expect(same).not.toHaveBeenCalled()
  })
})

describe('the room edit says one thing', () => {
  it('it never also asks to keep the setting, and its check knows what the third image is', async () => {
    const same = vi.fn().mockResolvedValueOnce({ same: true, differs: '' }).mockResolvedValueOnce({ same: false, differs: 'rug' }).mockResolvedValue({ same: true, differs: '' })
    const d = deps(same)
    await makeStill(job({ fileId: 'anchor', guides: ['guide-1', 'guide-2'] }), ctx, d)
    const edit = (d.generateStill as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(edit.prompt).not.toMatch(/Keep everything else exactly: the pose, framing, setting/)
    expect(edit.prompt).toMatch(/Keep everything else exactly: the pose, framing, outfit/)
    const gate = (d.promptGate as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(gate.planLine).toMatch(/image 3 is the first look's still, given only for its room/)
  })
})

describe('the workflow gives later person stills the first kept still as their room', () => {
  it('stills after the first unit are room-checked against it; the first unit is not', async () => {
    const { InMemoryStore } = await import('@mastra/core/storage')
    const { RequestContext } = await import('@mastra/core/request-context')
    const { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } = await import('./instance.js')
    const { setRemakeDeps } = await import('./deps.js')
    setRemakeStorageForTests(new InMemoryStore())
    const rc = () => { const r = new RequestContext(); r.set('tenantId', 't1'); r.set('idToken', 'tok'); r.set('conversationId', 'c1'); r.set('sessionId', 's1'); return r }
    const b = breakdown()
    let made = 0
    const sameSetting = vi.fn().mockResolvedValue({ same: true, differs: '' })
    setRemakeDeps({
      ask: () => vi.fn().mockResolvedValue({ lines: [] }), generateStill: vi.fn(async () => ({ fileId: `img-${++made}`, creditsUsedMicro: '100' })) as never,
      promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
      fetchImage: vi.fn(async (id: string) => ({ data: id, mime: 'image/jpeg' })), localFile: vi.fn(async (id: string) => `/m/${id}`),
      upload: vi.fn(async (_t: string, key: string) => `up:${key.split('/').pop()}`),
      poseImage: vi.fn().mockResolvedValue({ model: 'm', people: 1, no_person: false, main: b.pose!.looks[0].main_start }),
      stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [] }), cutBoard: vi.fn().mockResolvedValue(null), sameSetting,
      ffmpeg: vi.fn().mockResolvedValue(undefined), readFile: vi.fn(() => Buffer.from('x')), renderPreview: vi.fn().mockResolvedValue('/m/p.mp4'),
      imageRateMicro: vi.fn().mockResolvedValue(1_000_000n), clipRateMicro: vi.fn().mockResolvedValue(1_000_000n), musicRateMicro: vi.fn().mockResolvedValue(1_000_000n),
    })
    try {
      const run = await (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID).createRun()
      await run.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: b, brand: { name: 'B', product: 'p' }, castFileId: 'own' }, requestContext: rc() })
      await (await (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID).createRun({ runId: run.runId })).resume({ step: 'plan', resumeData: { decision: 'approve' }, requestContext: rc() })
      // original frames compared, then each later still against the first kept still
      const stillVsRoom = sameSetting.mock.calls.filter((c) => /^img-/.test(c[1].data))
      expect(stillVsRoom.length).toBeGreaterThan(0)
      expect(stillVsRoom.every((c) => c[2].data === stillVsRoom[0][2].data)).toBe(true)
    } finally { setRemakeDeps(null); setRemakeStorageForTests(null) }
  }, 30_000)
})
