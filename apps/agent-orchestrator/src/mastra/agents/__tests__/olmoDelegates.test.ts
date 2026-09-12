import { describe, it, expect } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import type { TenantContext } from '../../context.js'
import { buildOlmoDelegates } from '../olmoDelegates.js'
import { pmAgentDelegate } from '../pmAgent.js'
import { architectAgentDelegate } from '../architectAgent.js'
import { directorAgentDelegate } from '../directorAgent.js'
import { producerAgentDelegate } from '../producerAgent.js'

describe('buildOlmoDelegates', () => {
  it('returns all four delegates when isBuiltInAgent is true', () => {
    const requestContext = new RequestContext<TenantContext>()
    requestContext.set('agentName', 'Olmo')
    requestContext.set('isBuiltInAgent', true)
    const delegates = buildOlmoDelegates({ requestContext })
    expect(Object.keys(delegates).sort()).toEqual(['architect', 'director', 'pm', 'producer'])
    expect(delegates.pm).toBe(pmAgentDelegate)
    expect(delegates.architect).toBe(architectAgentDelegate)
    expect(delegates.director).toBe(directorAgentDelegate)
    expect(delegates.producer).toBe(producerAgentDelegate)
  })

  it('returns no delegates once the depth ceiling is reached', () => {
    const requestContext = new RequestContext<TenantContext>()
    requestContext.set('agentName', 'Olmo')
    requestContext.set('isBuiltInAgent', true)
    requestContext.set('delegationDepth', 1)
    expect(buildOlmoDelegates({ requestContext })).toEqual({})
  })

  it('gates on isBuiltInAgent, not the (renamed or differently-cased) agent name', () => {
    const requestContext = new RequestContext<TenantContext>()
    requestContext.set('agentName', 'Ogo')
    requestContext.set('isBuiltInAgent', true)
    expect(Object.keys(buildOlmoDelegates({ requestContext }))).toHaveLength(4)
  })

  it('returns no delegates for a different row, even one named "Olmo"', () => {
    const requestContext = new RequestContext<TenantContext>()
    requestContext.set('agentName', 'Research Engineer')
    expect(buildOlmoDelegates({ requestContext })).toEqual({})
  })

  it('returns no delegates when agentName is unset (e.g. Studio tool discovery)', () => {
    const requestContext = new RequestContext<TenantContext>()
    expect(buildOlmoDelegates({ requestContext })).toEqual({})
  })

  it('returns no delegates when requestContext itself is undefined', () => {
    expect(buildOlmoDelegates({ requestContext: undefined })).toEqual({})
  })
})
