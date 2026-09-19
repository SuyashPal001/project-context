import { describe, it, expect } from 'vitest'
import { assistantWordCount } from './canvasCompliance.js'

describe('assistantWordCount', () => {
  it('counts words across all assistant text parts', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'ignore me, ten words here to pad this out ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Here is a short summary.' }] },
    ]
    expect(assistantWordCount(messages as any)).toBe(5)
  })

  it('ignores non-text parts and non-assistant messages', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'render_canvas' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ]
    expect(assistantWordCount(messages as any)).toBe(1)
  })

  it('returns 0 for no assistant text', () => {
    expect(assistantWordCount([] as any)).toBe(0)
  })
})
