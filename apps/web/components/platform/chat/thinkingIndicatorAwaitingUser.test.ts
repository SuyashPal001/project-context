import { describe, it, expect } from 'vitest'
import { isAwaitingUser } from './ThinkingIndicator'
import type { ToolCall } from './types'

const call = (toolName: string, isLoading = true) => ({ id: toolName, toolName, isLoading, arguments: {} }) as unknown as ToolCall

describe('isAwaitingUser', () => {
  it('is true while only a clarification card is waiting on the user', () => {
    expect(isAwaitingUser([call('ask_clarifying_questions')])).toBe(true)
  })

  it('is false while the agent is still working on something else', () => {
    expect(isAwaitingUser([call('ask_clarifying_questions'), call('agent-director')])).toBe(false)
    expect(isAwaitingUser([call('agent-director')])).toBe(false)
    expect(isAwaitingUser([])).toBe(false)
  })

  it('ignores finished calls', () => {
    expect(isAwaitingUser([call('agent-director', false), call('ask_clarifying_questions')])).toBe(true)
  })
})
