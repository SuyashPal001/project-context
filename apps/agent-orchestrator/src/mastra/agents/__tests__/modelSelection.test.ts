import { describe, it, expect, vi } from 'vitest'

vi.mock('../../model.js', () => ({
  platformModel: 'PLATFORM_MODEL',
  liteModel: 'LITE_MODEL',
  privateModel: 'PRIVATE_MODEL',
  resolveModel: vi.fn((modelString: string) => `RESOLVED(${modelString})`),
}))

import { selectModel } from '../modelSelection.js'
import { resolveModel } from '../../model.js'

function makeContext(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] }
}

describe('selectModel', () => {
  it('returns privateModel for restricted data, ignoring any selected model', () => {
    const ctx = makeContext({ maxDataSensitivity: 'restricted', selectedModel: 'openrouter/anthropic/claude-opus-5' })
    expect(selectModel({ requestContext: ctx as any })).toBe('PRIVATE_MODEL')
  })

  it('resolves a user-selected model when one is set and data is not restricted', () => {
    const ctx = makeContext({ selectedModel: 'openrouter/anthropic/claude-opus-5' })
    const result = selectModel({ requestContext: ctx as any })
    expect(resolveModel).toHaveBeenCalledWith('openrouter/anthropic/claude-opus-5')
    expect(result).toBe('RESOLVED(openrouter/anthropic/claude-opus-5)')
  })

  it('falls back to liteModel when thinkingBudget is 0 and no model is selected', () => {
    const ctx = makeContext({ thinkingBudget: 0 })
    expect(selectModel({ requestContext: ctx as any })).toBe('LITE_MODEL')
  })

  it('falls back to platformModel by default', () => {
    const ctx = makeContext({})
    expect(selectModel({ requestContext: ctx as any })).toBe('PLATFORM_MODEL')
  })

  it('handles a missing requestContext', () => {
    expect(selectModel({ requestContext: undefined as any })).toBe('PLATFORM_MODEL')
  })
})
