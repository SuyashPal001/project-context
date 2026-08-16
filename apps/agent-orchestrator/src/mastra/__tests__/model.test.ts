import { describe, it, expect } from 'vitest'
import { resolveModel, buildGatewayModelString } from '../model.js'

describe('buildGatewayModelString', () => {
  it('prefixes openrouter models with the gateway routing prefix', () => {
    expect(buildGatewayModelString('openrouter', 'anthropic/claude-opus-5')).toBe('openrouter/anthropic/claude-opus-5')
  })

  it('passes anthropic models through unchanged (already claude-* shaped)', () => {
    expect(buildGatewayModelString('anthropic', 'claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
  })

  it('passes vertex models through unchanged (already gemini-* shaped)', () => {
    expect(buildGatewayModelString('vertex', 'gemini-2.5-pro')).toBe('gemini-2.5-pro')
  })

  it('returns null for providers the gateway does not route yet, so callers fall through to defaults', () => {
    expect(buildGatewayModelString('openai', 'gpt-5.1')).toBeNull()
    expect(buildGatewayModelString('mistral', 'mistral-large')).toBeNull()
    expect(buildGatewayModelString('kimi', 'kimi-k2')).toBeNull()
  })
})

describe('resolveModel', () => {
  it('builds a model connector whose modelId matches the given string', () => {
    const model = resolveModel('openrouter/anthropic/claude-opus-5')
    expect(model.modelId).toBe('openrouter/anthropic/claude-opus-5')
  })
})
