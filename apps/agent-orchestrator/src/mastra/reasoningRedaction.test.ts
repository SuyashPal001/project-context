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

describe('redactReasoningText grammar', () => {
  it('keeps verb forms readable', () => {
    expect(redactReasoningText('Direct delegation to X')).toBe('Direct handoff to X')
    expect(redactReasoningText('I will delegate this')).toBe('I will hand off this')
    expect(redactReasoningText('it delegated the work')).toBe('it handed off the work')
  })
  it('drops backticks around redacted names', () => {
    expect(redactReasoningText('call `agent-director` now')).toBe('call the visual generation step now')
  })
})

describe('redactReasoningText tool nouns', () => {
  it('reads naturally when a tool name is used as a noun', () => {
    expect(redactReasoningText('directly call the generate_image tool when')).toBe('directly call the image generator when')
    expect(redactReasoningText('I will call generate_image now')).toBe('I will call the image generator now')
    expect(redactReasoningText('the `generate-video` tool')).toBe('the video generator')
  })
})

describe('redactReasoningText own-tool phrasing', () => {
  it('handles "my own generate_image tool"', () => {
    expect(redactReasoningText('call my own generate_image tool directly')).toBe('call the image generator directly')
  })
})
