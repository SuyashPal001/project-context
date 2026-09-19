import { describe, it, expect } from 'vitest'
import { hasStrayQuestion } from './clarificationToolUsage.js'

describe('hasStrayQuestion', () => {
  it('flags a question mark in assistant text', () => {
    const messages = [
      {
        role: 'assistant',
        content: { format: 2, parts: [{ type: 'text', text: 'Which format do you want?' }] },
      },
    ]
    expect(hasStrayQuestion(messages as any)).toBe(true)
  })

  it('ignores question marks in non-assistant messages', () => {
    const messages = [
      {
        role: 'user',
        content: { format: 2, parts: [{ type: 'text', text: 'What do you think?' }] },
      },
      {
        role: 'assistant',
        content: { format: 2, parts: [{ type: 'text', text: 'Got it, working on it now.' }] },
      },
    ]
    expect(hasStrayQuestion(messages as any)).toBe(false)
  })

  it('returns false for empty input', () => {
    expect(hasStrayQuestion([] as any)).toBe(false)
  })
})
