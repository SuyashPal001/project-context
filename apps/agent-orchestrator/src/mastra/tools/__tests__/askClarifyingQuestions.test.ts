import { describe, it, expect, vi } from 'vitest'
import { askClarifyingQuestionsTool } from '../askClarifyingQuestions.js'
import { pendingClarifications } from '../../../types.js'

describe('askClarifyingQuestionsTool', () => {
  it('resolves once all questions are answered via pendingClarifications', async () => {
    const sendEvent = vi.fn()
    const requestContext = {
      get: (key: string) =>
        key === 'sendEvent' ? sendEvent
        : key === 'sessionId' ? 'session-1'
        : key === 'tenantId' ? 'tenant-1'
        : key === 'userId' ? 'user-1'
        : undefined,
    }

    const input = {
      questions: [
        { prompt: 'Length?', options: [{ label: '30s' }, { label: '60s' }], allowFreeText: true, allowSkip: true },
      ],
    }

    const resultPromise = askClarifyingQuestionsTool.execute!(input as any, { requestContext } as any)

    // Simulate the frontend resolving the single pending question
    await vi.waitFor(() => expect(pendingClarifications.size).toBe(1))
    const [[clarificationId, pending]] = pendingClarifications.entries()
    pending.collected.push({ questionIndex: 0, selectedIndex: 1 })
    pending.resolve(pending.collected)
    pendingClarifications.delete(clarificationId)

    const result = await resultPromise
    expect(sendEvent).toHaveBeenCalledWith('clarification_request', expect.objectContaining({ questions: input.questions }))
    expect((result as any).answers[0].selectedLabel).toBe('60s')
  })

  it('returns no_active_session when sendEvent/sessionId are missing', async () => {
    const requestContext = { get: () => undefined }
    // Must satisfy the tool's inputSchema (questions: min 1) — Mastra's createTool
    // validates input before execute() runs, so an empty array short-circuits with
    // a schema-validation error object instead of reaching our no_active_session
    // branch.
    const input = {
      questions: [
        { prompt: 'Length?', options: [{ label: '30s' }], allowFreeText: true, allowSkip: true },
      ],
    }
    const result = await askClarifyingQuestionsTool.execute!(input as any, { requestContext } as any)
    expect((result as any).error).toBe('no_active_session')
  })

  it('returns partial answers on timeout instead of discarding them', async () => {
    vi.useFakeTimers()
    try {
      const sendEvent = vi.fn()
      const requestContext = {
        get: (key: string) =>
          key === 'sendEvent' ? sendEvent
          : key === 'sessionId' ? 'session-2'
          : key === 'tenantId' ? 'tenant-1'
          : key === 'userId' ? 'user-1'
          : undefined,
      }

      const input = {
        questions: [
          { prompt: 'Length?', options: [{ label: '30s' }, { label: '60s' }] },
          { prompt: 'Tone?', options: [{ label: 'Formal' }, { label: 'Casual' }] },
        ],
      }

      const resultPromise = askClarifyingQuestionsTool.execute!(input as any, { requestContext } as any)

      // Only the first of two questions gets answered before the user goes idle.
      await vi.waitFor(() => expect(pendingClarifications.size).toBe(1), { timeout: 5000 })
      const [[, pending]] = pendingClarifications.entries()
      pending.collected.push({ questionIndex: 0, selectedIndex: 1 })

      await vi.advanceTimersByTimeAsync(120_000)

      const result = await resultPromise
      expect((result as any).answers).toHaveLength(1)
      expect((result as any).answers[0].selectedLabel).toBe('60s')
    } finally {
      vi.useRealTimers()
    }
  })
})
