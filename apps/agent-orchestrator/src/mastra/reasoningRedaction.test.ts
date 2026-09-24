import { describe, it, expect } from 'vitest'
import { redactReasoningText } from './reasoningRedaction.js'

describe('redactReasoningText', () => {
  it('hides internal tool names', () => {
    const out = redactReasoningText('call updateWorkingMemory then generate_image via agent-director')
    expect(out).not.toMatch(/updateWorkingMemory|generate_image|agent-director/)
  })

  it('does not double the article after a replacement', () => {
    expect(redactReasoningText('hand it to the agent-director')).toBe('hand it to the visual generation step')
  })

  it('leaves ordinary reasoning untouched', () => {
    const text = 'Simple request: one blue car image.'
    expect(redactReasoningText(text)).toBe(text)
  })
})
