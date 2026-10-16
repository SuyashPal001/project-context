// "Edit, never regenerate" (user rule): a still with the wrong face, a lookalike or a duplicate
// object is retried by EDITING it (the failed still first, the chosen person's sheet second), so the
// pose, framing and scene that passed are kept. Only a wrong pose (facing, nobody in shot) makes a
// fresh image again: an edit can't turn a body around.
import { describe, it, expect, vi } from 'vitest'
import { makeStill, type StillCtx, type StillJob } from './paidStill.js'
import type { RemakeDeps } from './deps.js'
import { remakeLooks } from './looks.js'
import { breakdown, body } from './fixtures.testing.js'

const img = { data: 'AA', mime: 'image/jpeg' }
const ctx: StillCtx = { tenantId: 't', idToken: 'tok', scopeId: 's', runId: 'r', exec: () => ({ requestContext: { get: () => undefined }, agent: { toolCallId: 'remake:r' } }), portrait: { fileId: 'sheet', img } }
const job = (): StillJob => ({ look: remakeLooks(breakdown())[0], kind: 'start', prompt: 'P', references: ['sheet', 'guide', 'anchor'], aspectRatio: '9:16', gate: { prompt: 'P', planLine: 'x', look: {}, startFrameObjects: [], keyMoments: [] } })
let n = 0
const deps = (first: { reasons: string[] }, pose?: unknown): RemakeDeps => ({
  ask: () => vi.fn(), fetchImage: vi.fn().mockResolvedValue(img), localFile: vi.fn().mockResolvedValue('/m/x'), upload: vi.fn(),
  generateStill: vi.fn().mockImplementation(async () => ({ fileId: `still-${++n}`, creditsUsedMicro: '100' })),
  poseImage: vi.fn().mockResolvedValue(pose ?? { model: 'm', people: 1, no_person: false, main: remakeLooks(breakdown())[0].start }),
  promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
  stillChecks: vi.fn().mockResolvedValueOnce({ passed: first.reasons.length === 0, reasons: first.reasons }).mockResolvedValue({ passed: true, reasons: [] }),
} as unknown as RemakeDeps)

describe('the retry edits the failed still', () => {
  it('a wrong face: edit the failed still toward the sheet, keeping everything else', async () => {
    n = 0
    const d = deps({ reasons: ['the face differs from the chosen person: different nose'] })
    const r = await makeStill(job(), ctx, d)
    const second = (d.generateStill as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(second.referenceFileIds).toEqual(['still-1', 'sheet'])
    expect(second.prompt).toMatch(/^Edit the first image\. Change only this: the face must be exactly the person in the second image\./)
    expect(second.prompt).toMatch(/Keep everything else exactly/)
    expect(r.result).toMatchObject({ fileId: 'still-2', status: 'passed' })
  })
  it('a duplicate object is edited out the same way', async () => {
    n = 0
    const d = deps({ reasons: ['an object appears twice (two remotes)'] })
    await makeStill(job(), ctx, d)
    expect((d.generateStill as ReturnType<typeof vi.fn>).mock.calls[1][0].prompt).toMatch(/Change only this: show each object only once/)
  })
  it('a wrong facing makes a fresh image from the original references', async () => {
    n = 0
    const look = { ...remakeLooks(breakdown())[0], start: body({ facing: 'back' } as never) }
    const d = deps({ reasons: [] }, { model: 'm', people: 1, no_person: false, main: body({ facing: 'front' } as never) })
    await makeStill({ ...job(), look }, ctx, d)
    const second = (d.generateStill as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(second.referenceFileIds).toEqual(['sheet', 'guide', 'anchor'])
    expect(second.prompt).toMatch(/^P Fix:/)
  })
})
