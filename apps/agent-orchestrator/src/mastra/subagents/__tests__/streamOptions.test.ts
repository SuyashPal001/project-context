import { describe, it, expect } from 'vitest'
import { olmoDelegationOptions, OLMO_MAX_STEPS } from '../streamOptions.js'

const host = { tenantId: 'tenant-1', conversationId: 'conv-1', agentId: 'agent-1' }

describe('olmoDelegationOptions', () => {
  it('carries an explicit step budget well above the Mastra default of 5', () => {
    expect(olmoDelegationOptions(host).maxSteps).toBe(OLMO_MAX_STEPS)
    expect(OLMO_MAX_STEPS).toBeGreaterThan(5)
  })

  it('carries both delegation hooks and the throwing error strategy', () => {
    const { delegation } = olmoDelegationOptions(host)
    expect(typeof delegation.onDelegationStart).toBe('function')
    expect(typeof delegation.onDelegationComplete).toBe('function')
    expect(delegation.hookErrorStrategy).toBe('throw')
  })
})
