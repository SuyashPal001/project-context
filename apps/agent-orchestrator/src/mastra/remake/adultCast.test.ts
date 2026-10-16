// Metro lip-sync test (2026-10-16): the cast lead ("early 20s") read as possibly under 18 to Google's video
// filter, so the clip was blocked after every still had passed. The cast is now always described as
// clearly an adult, and the picked person is checked (free) before any still is paid for.
import { describe, it, expect, vi } from 'vitest'
import { enforceRules } from './plan.js'
import { castSheetPrompt, characterPortraitPrompt } from './prompts.js'
import { looksUnder18 } from './stillChecks.js'

const refs = [{ ref: 'cast', what: 'the person on screen' }, { ref: 'characters[0]', what: 'woman seated in the train' }]
const ctx = { brand: { name: 'Snitch', product: 'tee' }, musicMood: 'pop' }

describe('the cast is always clearly an adult', () => {
  it('cast and characters say so; "early 20s" becomes mid-20s', () => {
    const { lines } = enforceRules([{ ref: 'cast', action: 'swap', to: 'a trendy young man in his early 20s' }, { ref: 'characters[0]', action: 'swap', to: 'a young woman, early twenties' }], refs, ctx)
    for (const l of lines) {
      expect(l.to).toMatch(/clearly an adult, mid-20s or older/)
      expect(l.to).not.toMatch(/early (20s|twenties)/)
    }
  })
  it('the casting sheet and portraits ask for adults', () => {
    expect(castSheetPrompt('x')).toMatch(/clearly an adult, mid-20s or older/)
    expect(characterPortraitPrompt('x')).toMatch(/clearly an adult, mid-20s or older/)
  })
})

describe('the picked person is checked for looking under 18', () => {
  it('yes when the checker says the person could pass for under 18', async () => {
    expect(await looksUnder18(vi.fn().mockResolvedValue({ could_be_under_18: true }) as never, { data: 'A', mime: 'image/jpeg' })).toBe(true)
    expect(await looksUnder18(vi.fn().mockResolvedValue({ could_be_under_18: false }) as never, { data: 'A', mime: 'image/jpeg' })).toBe(false)
  })
  it('a checker that fails never blocks the pick', async () => {
    expect(await looksUnder18(vi.fn().mockRejectedValue(new Error('down')) as never, { data: 'A', mime: 'image/jpeg' })).toBe(false)
  })
})

describe('the cast step checks the picked person before any still', () => {
  it('a pick that may read as under 18 asks for another pick, with no still paid', async () => {
    const { InMemoryStore } = await import('@mastra/core/storage')
    const { RequestContext } = await import('@mastra/core/request-context')
    const { remakeMastra, setRemakeStorageForTests, REMAKE_WORKFLOW_ID } = await import('./instance.js')
    const { setRemakeDeps } = await import('./deps.js')
    const { breakdown } = await import('./fixtures.testing.js')
    setRemakeStorageForTests(new InMemoryStore())
    const rc = () => { const r = new RequestContext(); r.set('tenantId', 't1'); r.set('idToken', 'tok'); r.set('conversationId', 'c1'); r.set('sessionId', 's1'); return r }
    let made = 0
    const generateStill = vi.fn(async () => ({ fileId: `img-${++made}`, creditsUsedMicro: '100' }))
    const ask = vi.fn(async (parts: Array<{ text?: string }>) => (parts.some((p) => /under 18/.test(p.text ?? '')) ? { could_be_under_18: true } : { lines: [] }))
    setRemakeDeps({
      ask: () => ask as never, generateStill: generateStill as never,
      promptGate: vi.fn().mockResolvedValue({ name: 'prompt', status: 'pass', reason: '', evidenceTimes: [] }),
      fetchImage: vi.fn().mockResolvedValue({ data: 'AA', mime: 'image/jpeg' }), localFile: vi.fn().mockImplementation(async (id: string) => `/m/${id}`),
      upload: vi.fn().mockImplementation(async (_t: string, key: string) => `up:${key.split('/').pop()}`),
      ffmpeg: vi.fn().mockResolvedValue(undefined), readFile: vi.fn(() => Buffer.from('x')), imageRateMicro: vi.fn().mockResolvedValue(1_000_000n),
    })
    try {
      const w = (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID)
      const run = await w.createRun()
      await run.start({ inputData: { tenantId: 't1', conversationId: 'c1', breakdown: breakdown(), brand: { name: 'B', product: 'p' } }, requestContext: rc() })
      const resume = async (step: string, data: unknown) => (await ((await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID)).createRun({ runId: run.runId })).resume({ step, resumeData: data, requestContext: rc() })
      await resume('plan', { decision: 'approve' })
      const out = await resume('cast', { pick: 2 }) as unknown as { status: string; steps: Record<string, { suspendPayload?: Record<string, unknown> }> }
      expect(out.status).toBe('suspended')
      expect(out.steps.cast.suspendPayload).toMatchObject({ stage: 'cast_pick', sheetFileId: 'img-1' })
      expect(String(out.steps.cast.suspendPayload!.error)).toMatch(/could pass for under 18.*pick another/)
      expect(generateStill).toHaveBeenCalledTimes(1) // the casting sheet only
    } finally { setRemakeDeps(null); setRemakeStorageForTests(null) }
  }, 30_000)
})
