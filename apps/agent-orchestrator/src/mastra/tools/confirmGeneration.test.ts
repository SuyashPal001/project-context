import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { isUnlimited, resolveRate, saveGenerationConfirmRequest, updateGenerationConfirmRequest } = vi.hoisted(() => ({
  isUnlimited: vi.fn(),
  resolveRate: vi.fn(),
  saveGenerationConfirmRequest: vi.fn(),
  updateGenerationConfirmRequest: vi.fn(),
}))
vi.mock('@serverless-saas/credits', () => ({ isUnlimited, resolveRate }))
vi.mock('../../persistence.js', () => ({ saveGenerationConfirmRequest, updateGenerationConfirmRequest }))

import { confirmGenerationOrDecline } from './confirmGeneration.js'
import { pendingGenerationConfirmations, sessionActiveGenerationConfirmations } from '../../types.js'

function ctx(values: Record<string, unknown>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext } as never
}
const sendEvent = vi.fn()
const baseCtx = () => ctx({
  tenantId: 't1', sessionId: 's1', userId: 'u1', conversationId: 'c1', idToken: 'tok', sendEvent,
})

beforeEach(() => {
  vi.resetAllMocks()
  pendingGenerationConfirmations.clear()
  sessionActiveGenerationConfirmations.clear()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 50_000 } })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('confirmGenerationOrDecline', () => {
  it('skips the gate for an unlimited tenant — no sendEvent', async () => {
    isUnlimited.mockResolvedValue(true)
    const result = await confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    expect(result).toEqual({ confirmed: true })
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('skips the gate when allowMode is auto — no sendEvent', async () => {
    const result = await confirmGenerationOrDecline(
      ctx({ tenantId: 't1', sessionId: 's1', userId: 'u1', conversationId: 'c1', idToken: 'tok', sendEvent, allowMode: 'auto' }),
      'image_generation', 'model-x', 'Generate image',
    )
    expect(result).toEqual({ confirmed: true })
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('skips the gate when no active rate resolves — no sendEvent', async () => {
    resolveRate.mockResolvedValue(null)
    const result = await confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    expect(result).toEqual({ confirmed: true })
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('skips the gate when there is no active session — no sendEvent', async () => {
    const noSessionCtx = ctx({ tenantId: 't1' }) // missing sendEvent/sessionId/userId
    const result = await confirmGenerationOrDecline(noSessionCtx, 'image_generation', 'model-x', 'Generate image')
    expect(result).toEqual({ confirmed: true })
  })

  it('sends the event, persists, and resolves confirmed when the pending map is resolved with true', async () => {
    const promise = confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledTimes(1))
    expect(sendEvent).toHaveBeenCalledWith('generation_confirm_request', expect.objectContaining({
      resourceType: 'image_generation', subject: 'model-x', label: 'Generate image',
    }))
    expect(saveGenerationConfirmRequest).toHaveBeenCalledTimes(1)

    const [[confirmationId]] = sessionActiveGenerationConfirmations.get('s1')
      ? [Array.from(sessionActiveGenerationConfirmations.get('s1')!)]
      : [[]]
    const pending = pendingGenerationConfirmations.get(confirmationId)
    pending!.resolve({ confirmed: true })

    const result = await promise
    expect(result).toEqual({ confirmed: true })
  })

  it('resolves declined when the pending map is resolved with confirmed: false', async () => {
    const promise = confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledTimes(1))
    const confirmationId = Array.from(sessionActiveGenerationConfirmations.get('s1')!)[0]
    pendingGenerationConfirmations.get(confirmationId)!.resolve({ confirmed: false })

    const result = await promise
    expect(result).toEqual({ confirmed: false })
  })

  it('forwards declineReason through to the tool result', async () => {
    const promise = confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledTimes(1))
    const confirmationId = Array.from(sessionActiveGenerationConfirmations.get('s1')!)[0]
    pendingGenerationConfirmations.get(confirmationId)!.resolve({ confirmed: false, declineReason: 'Make it slower' })

    const result = await promise
    expect(result).toEqual({ confirmed: false, declineReason: 'Make it slower' })
  })

  it('auto-declines after the 5-minute timeout', async () => {
    vi.useFakeTimers()
    const promise = confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    await vi.advanceTimersByTimeAsync(300_000)
    const result = await promise
    expect(result).toEqual({ confirmed: false })
  })

  it('declines a second concurrent request for the same session without sending a second event', async () => {
    const first = confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    await vi.waitFor(() => expect(sendEvent).toHaveBeenCalledTimes(1))

    const second = await confirmGenerationOrDecline(baseCtx(), 'image_generation', 'model-x', 'Generate image')
    expect(second).toEqual({ confirmed: false, reason: 'CONFIRM_BUSY' })
    expect(sendEvent).toHaveBeenCalledTimes(1) // still just the first

    const confirmationId = Array.from(sessionActiveGenerationConfirmations.get('s1')!)[0]
    pendingGenerationConfirmations.get(confirmationId)!.resolve({ confirmed: true })
    await first
  })
})
