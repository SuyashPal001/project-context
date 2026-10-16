import { describe, it, expect, vi } from 'vitest'
import { makeClip, clipSlot, type ClipCtx } from './paidClip.js'
import { clipSpecs } from './clipSpec.js'
import { writePlan } from './plan.js'
import { breakdown } from './fixtures.testing.js'
import type { RemakeDeps } from './deps.js'

const brand = { name: 'B', product: 'p' }
const pass = { name: 'x', status: 'pass' as const, reason: '', evidenceTimes: [] }
async function setup(o: Partial<RemakeDeps> = {}) {
  const plan = await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] }))
  const specs = clipSpecs(plan, [
    { look: 1, kind: 'start', fileId: 's1', status: 'passed', reasons: [] },
    { look: 2, kind: 'start', fileId: 's2', status: 'passed', reasons: [] },
    { look: 2, kind: 'end', fileId: 'e2', status: 'passed', reasons: [] },
  ])
  let n = 0
  const deps = {
    promptGate: vi.fn(async () => pass),
    generateVeoClip: vi.fn(async () => ({ fileId: `veo-${++n}`, creditsUsedMicro: '160' })),
    generateOmniClip: vi.fn(async () => ({ fileId: `omni-${++n}`, creditsUsedMicro: '100' })),
    localFile: vi.fn(async (id: string) => `/m/${id}`),
    fitToFrames: vi.fn(async (_i: string, _f: number, out: string) => out),
    poseClip: vi.fn(), sample: vi.fn(),
    ...o,
  } as unknown as RemakeDeps
  const check = vi.fn(async () => pass)
  const ctx: ClipCtx = { tenantId: 't', idToken: 'tok', scopeId: 's', runId: 'r', exec: () => ({}), portrait: null, plan, brand, size: { width: 720, height: 1280 }, workDir: '/tmp/x', check }
  return { plan, specs, deps, ctx, check }
}

describe('makeClip', () => {
  it('Veo between two stills, trimmed to the look frames, kept when checks pass', async () => {
    const { specs, deps, ctx } = await setup()
    const r = await makeClip(specs[1], ctx, deps)
    expect(r.result).toMatchObject({ look: 2, engine: 'veo', fallback: false, status: 'passed', fileId: 'veo-1' })
    expect(deps.generateVeoClip).toHaveBeenCalledWith(expect.objectContaining({ startImageFileId: 's2', endImageFileId: 'e2', durationSeconds: 6 }), expect.anything(), clipSlot(2, 0, 'normal'))
    expect(deps.fitToFrames).toHaveBeenCalledWith('/m/veo-1', specs[1].frames, expect.any(String), { width: 720, height: 1280 })
    expect(r.ledger).toEqual([{ item: 'look 2 clip', attempt: 0, creditsMicro: '160', outcome: 'kept' }])
  })
  it('a person who may read as under 18: no reworded retry, no other model; the user is told in plain words', async () => {
    const { specs, deps, ctx } = await setup({ generateVeoClip: vi.fn(async () => ({ refused: true, refusalReason: 'MINOR_BLOCKED' })) } as never)
    const r = await makeClip(specs[1], ctx, deps)
    expect(deps.generateVeoClip).toHaveBeenCalledTimes(1)
    expect(deps.generateOmniClip).not.toHaveBeenCalled()
    expect(r.result).toMatchObject({ status: 'blocked', fileId: null })
    expect(r.result.reasons.join(' ')).toMatch(/looks too young/)
    expect(r.result.reasons.join(' ')).not.toMatch(/MINOR_BLOCKED|Veo|Vertex|17301594/)
  })
  it('Veo refused → exactly one Omni attempt from the start still, gated, marked fallback (Review Focus 3)', async () => {
    const { specs, deps, ctx } = await setup({ generateVeoClip: vi.fn(async () => ({ refused: true, refusalReason: 'CONTENT_BLOCKED' })) } as never)
    const r = await makeClip(specs[1], ctx, deps)
    // M12: the plainer-wording Veo retry comes first (also refused here), then one Omni attempt.
    expect(deps.generateVeoClip).toHaveBeenCalledTimes(2)
    expect(deps.generateOmniClip).toHaveBeenCalledWith(expect.objectContaining({ startImageFileId: 's2', durationSeconds: 7 }), expect.anything(), clipSlot(2, 0, 'fallback')) // Omni's own length: 5.9s + warm-up + margin
    expect(deps.promptGate).toHaveBeenCalledTimes(3)
    expect(r.result).toMatchObject({ engine: 'omni', fallback: true, status: 'passed' })
    expect(r.ledger.map((e) => e.outcome)).toEqual(['retried', 'retried', 'kept'])
  })
  it('retries a failed check once with the reasons, then stops', async () => {
    const { specs, deps, ctx, check } = await setup()
    check.mockResolvedValue({ ...pass, status: 'fail', reason: 'end pose: knees bent' } as never)
    const r = await makeClip(specs[0], ctx, deps)
    expect(deps.generateOmniClip).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.generateOmniClip).mock.calls[1][0].prompt).toMatch(/Fix: end pose: knees bent$/)
    expect(r.result.status).toBe('failed')
    expect(r.ledger.map((e) => e.outcome)).toEqual(['retried', 'failed'])
  })
  it('never retries on unknown', async () => {
    const { specs, deps, ctx, check } = await setup()
    check.mockResolvedValue({ ...pass, status: 'unknown', reason: 'the clip could not be checked this time' } as never)
    const r = await makeClip(specs[0], ctx, deps)
    expect(deps.generateOmniClip).toHaveBeenCalledTimes(1)
    expect(r.result.status).toBe('unchecked')
  })
  it('a blocked gate pays nothing; a look with no clip pays nothing', async () => {
    const { specs, deps, ctx } = await setup({ promptGate: vi.fn(async () => ({ ...pass, status: 'unknown', reason: 'check unavailable: gateway 503' })) } as never)
    const r = await makeClip(specs[0], ctx, deps)
    expect(r.result.status).toBe('blocked')
    expect(r.result.reasons.join(' ')).not.toMatch(/gateway|503/)
    expect(deps.generateOmniClip).not.toHaveBeenCalled()
    const none = await makeClip({ ...specs[0], engine: 'none', reason: 'this part is too long to animate yet, so it stays a still' }, ctx, deps)
    expect(none.result.status).toBe('still')
    expect(none.ledger).toEqual([])
  })
})

it('clip slots never collide with each other or with still slots (< 1000)', () => {
  const all = [1, 2, 3, 40].flatMap((n) => [0, 1].flatMap((a) => (['normal', 'plain', 'fallback'] as const).map((v) => clipSlot(n, a, v))))
  expect(new Set(all).size).toBe(all.length)
  expect(Math.min(...all)).toBeGreaterThanOrEqual(1000)
})

// Shared clip timing (tools/clipTiming, 2026-10-16): the fit decided per engine reaches the prompt and the trim.
describe('makeClip keeps real speed', () => {
  it('a short look: the Veo clip is cut at real speed and its prompt holds the pose after the look', async () => {
    const { plan, deps, ctx } = await setup()
    plan.looks[0] = { ...plan.looks[0], endS: 1.3 }; plan.looks[1] = { ...plan.looks[1], startS: 1.3 }
    const [s1] = clipSpecs(plan, [{ look: 1, kind: 'start', fileId: 's1', status: 'passed', reasons: [] }, { look: 1, kind: 'end', fileId: 'e1', status: 'passed', reasons: [] }])
    await makeClip(s1, ctx, deps)
    expect(deps.fitToFrames).toHaveBeenCalledWith('/m/veo-1', s1.frames, expect.any(String), { width: 720, height: 1280 }, 30, { startS: 0 })
    expect((deps.generateVeoClip as any).mock.calls[0][0].prompt).toMatch(/Finish every move by 1\.3s/)
  })
  it('a Veo refusal falls back to Omni at Omni\'s own length, trimmed past its warm-up', async () => {
    const { specs, deps, ctx } = await setup({ generateVeoClip: vi.fn(async () => ({ refused: true, refusalReason: 'CONTENT_BLOCKED' })) } as never)
    await makeClip(specs[1], ctx, deps)
    expect(deps.fitToFrames).toHaveBeenCalledWith('/m/omni-1', specs[1].frames, expect.any(String), { width: 720, height: 1280 }, 30, { startS: 0.4 })
  })
})
