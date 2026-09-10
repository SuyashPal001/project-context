import { describe, it, expect } from 'vitest'
import { assertBackgroundSupported } from '../sources.js'
import type { SubAgentSpec } from '../spec.js'

const spec = { id: 'renderer', background: { enabled: true as const, timeoutMs: 600_000 } } as SubAgentSpec

describe('assertBackgroundSupported', () => {
  it('rejects a background spec when the manager is disabled', () => {
    expect(() => assertBackgroundSupported([spec], false)).toThrow(/backgroundTasks/)
  })

  it('accepts a background spec when the manager is enabled', () => {
    expect(() => assertBackgroundSupported([spec], true)).not.toThrow()
  })

  it('accepts specs that declare no background at all, either way', () => {
    expect(() => assertBackgroundSupported([{ id: 'pm' } as SubAgentSpec], false)).not.toThrow()
  })
})
