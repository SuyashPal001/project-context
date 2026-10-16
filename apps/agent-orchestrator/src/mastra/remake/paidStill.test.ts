import { describe, it, expect, vi } from 'vitest'
import { makeStill, slotFor, type StillCtx, type StillJob } from './paidStill.js'
import type { RemakeDeps } from './deps.js'
import { remakeLooks } from './looks.js'
import { breakdown } from './fixtures.testing.js'

const look = remakeLooks(breakdown())[0]
const job: StillJob = { look, kind: 'start', prompt: 'P', references: ['portrait', 'guide'], aspectRatio: '9:16', gate: { prompt: 'P', planLine: 'x', look: {}, startFrameObjects: [], keyMoments: [] } }
const img = { data: 'AA', mime: 'image/jpeg' }
const ctx: StillCtx = { tenantId: 't', idToken: 'tok', scopeId: 's', runId: 'r', exec: () => ({ requestContext: { get: () => undefined }, agent: { toolCallId: 'remake:r' } }), portrait: { fileId: 'portrait', img } }
const pass = { name: 'prompt', status: 'pass' as const, reason: '', evidenceTimes: [] }
const okPose = { model: 'm', people: 1, no_person: false, main: look.start }

function deps(o: Partial<RemakeDeps> = {}): RemakeDeps {
  let n = 0
  return {
    ask: () => vi.fn(), fetchImage: vi.fn().mockResolvedValue(img), localFile: vi.fn().mockResolvedValue('/m/x.jpg'), upload: vi.fn(),
    generateStill: vi.fn().mockImplementation(async () => ({ fileId: `still-${++n}`, creditsUsedMicro: '100' })),
    poseImage: vi.fn().mockResolvedValue(okPose),
    promptGate: vi.fn().mockResolvedValue(pass),
    stillChecks: vi.fn().mockResolvedValue({ passed: true, reasons: [] }),
    ffmpeg: vi.fn(), readFile: vi.fn(() => Buffer.from('x')), renderPreview: vi.fn(), imageRateMicro: vi.fn(),
    ...o,
  } as RemakeDeps
}

describe('makeStill', () => {
  it('pays once and keeps a still that passes every check', async () => {
    const d = deps()
    const r = await makeStill(job, ctx, d)
    expect(r.result).toMatchObject({ fileId: 'still-1', status: 'passed' })
    expect(r.ledger).toEqual([{ item: 'look 1 start still', attempt: 0, creditsMicro: '100', outcome: 'kept' }])
    expect(d.generateStill).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'P', referenceFileIds: ['portrait', 'guide'], engine: 'gemini', aspectRatio: '9:16' }), expect.anything(), slotFor(1, 'start', 0))
  })
  it('blocks before paying when the gate fails or is unknown', async () => {
    for (const [status, why] of [['fail', 'adds a smile'], ['unknown', 'the still couldn’t be checked before making it, so it wasn’t made']] as const) {
      const d = deps({ promptGate: vi.fn().mockResolvedValue({ ...pass, status, reason: 'adds a smile' }) })
      const r = await makeStill(job, ctx, d)
      expect(r.result).toMatchObject({ status: 'blocked', fileId: null, reasons: [why] })
      expect(d.generateStill).not.toHaveBeenCalled()
    }
  })
  it('retries once with the reasons added, then stops', async () => {
    const d = deps({ poseImage: vi.fn().mockResolvedValue({ ...okPose, people: 2 }) })
    const r = await makeStill(job, ctx, d)
    expect(d.generateStill).toHaveBeenCalledTimes(2)
    expect((d.generateStill as ReturnType<typeof vi.fn>).mock.calls[1][0].prompt).toBe('P Fix: exactly as many people as the second image shows.') // plain plan words, not the check's text
    expect(d.promptGate).toHaveBeenCalledTimes(2)
    expect(r.result).toMatchObject({ status: 'failed', fileId: 'still-2' })
    expect(r.ledger.map((e) => e.outcome)).toEqual(['retried', 'failed'])
  })
  it('keeps the retry when it passes', async () => {
    const d = deps({ stillChecks: vi.fn().mockResolvedValueOnce({ passed: false, reasons: ['two cans'] }).mockResolvedValue({ passed: true, reasons: [] }) })
    const r = await makeStill(job, ctx, d)
    expect(r.result).toMatchObject({ status: 'passed', fileId: 'still-2' })
    expect(r.ledger.map((e) => e.outcome)).toEqual(['retried', 'kept'])
  })
  it('never retries on unknown: keeps the still as unchecked', async () => {
    const d = deps({ poseImage: vi.fn().mockRejectedValue(new Error('ai-service 500')) })
    const r = await makeStill(job, ctx, d)
    expect(d.generateStill).toHaveBeenCalledTimes(1)
    expect(r.result.status).toBe('unchecked')
    expect(r.result.reasons.join(' ')).not.toMatch(/ai-service/)
  })
  it('stops on insufficient credits with a plain reason', async () => {
    const d = deps({ generateStill: vi.fn().mockResolvedValue({ insufficientCredits: true }) })
    const r = await makeStill(job, ctx, d)
    expect(r.result).toMatchObject({ status: 'failed', reasons: ['not enough credits'] })
  })
  it('checks the face only when the look has a person', async () => {
    const d = deps()
    await makeStill(job, ctx, d)
    expect(d.stillChecks).toHaveBeenCalledWith(expect.anything(), img, { lead: img, leadInShot: true })
  })
})

it('slots never collide between looks, kinds and attempts, and 0 is the casting sheet', () => {
  const all = [1, 2, 3].flatMap((n) => (['start', 'end'] as const).flatMap((k) => [0, 1].map((a) => slotFor(n, k, a))))
  expect(new Set(all).size).toBe(all.length)
  expect(all).not.toContain(0)
})
