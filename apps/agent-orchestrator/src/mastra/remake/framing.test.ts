// Same camera as the original (2026-10-17): a still whose person sits much bigger, smaller or shifted
// against the original's frame fails and is fixed by an edit toward the original's framing.
import { describe, it, expect, vi } from 'vitest'
import { makeStill, type StillCtx, type StillJob } from './paidStill.js'
import { remakeLooks } from './looks.js'
import type { RemakeDeps } from './deps.js'
import { breakdown } from './fixtures.testing.js'

const img = (d: string) => ({ data: d, mime: 'image/jpeg' })
const look = remakeLooks(breakdown())[0]
const ctx: StillCtx = { tenantId: 't', idToken: 'tok', scopeId: 's', runId: 'r', exec: () => ({ requestContext: { get: () => undefined }, agent: { toolCallId: 'remake:r' } }) as never, portrait: { fileId: 'sheet', img: img('P') } }
const job: StillJob = { look, kind: 'start', prompt: 'P', references: ['sheet', 'guide-1'], aspectRatio: '9:16', gate: { prompt: 'P', planLine: 'x', look: {}, startFrameObjects: [], keyMoments: [] }, guide: 'guide-1' }
function deps(boxes: Record<string, number[] | undefined>) {
  let n = 0
  return {
    ask: () => vi.fn(), fetchImage: vi.fn(async (id: string) => img(id)), localFile: vi.fn(async (id: string) => id), upload: vi.fn(),
    generateStill: vi.fn(async () => ({ fileId: `still-${++n}`, creditsUsedMicro: '100' })),
    poseImage: vi.fn(async (p: string) => ({ model: 'm', people: 1, no_person: false, main: look.start, box: boxes[p] })),
    promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
    stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [], warnings: [] }),
  } as unknown as RemakeDeps
}

describe('a still keeps the original camera framing', () => {
  it('a much closer camera fails and is fixed by an edit toward the original framing', async () => {
    const d = deps({ 'guide-1': [0.3, 0.2, 0.7, 0.8], 'still-1': [0.1, 0.02, 0.9, 0.98], 'still-2': [0.3, 0.2, 0.7, 0.81] })
    const r = await makeStill(job, ctx, d)
    expect(r.result.status).toBe('passed')
    const edit = (d.generateStill as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(edit.prompt).toMatch(/the camera framing must match the original frame/)
    expect(r.result.tries?.[0].why.join(' ')).toMatch(/the camera is closer/)
  })
  it('the same framing passes on the first try', async () => {
    const d = deps({ 'guide-1': [0.3, 0.2, 0.7, 0.8], 'still-1': [0.31, 0.21, 0.69, 0.8] })
    expect((await makeStill(job, ctx, d)).result.status).toBe('passed')
    expect(d.generateStill).toHaveBeenCalledTimes(1)
  })
  it('a framing that can\'t be measured is a warning, not a pass in silence', async () => {
    const d = deps({ 'guide-1': undefined, 'still-1': [0.3, 0.2, 0.7, 0.8] })
    const r = await makeStill(job, ctx, d)
    expect(r.result.status).toBe('warned')
    expect(r.result.reasons.join(' ')).toMatch(/framing could not be compared/)
  })
})
