import { describe, it, expect } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import type { TenantContext } from '../../context.js'
import { buildOlmoDelegates } from '../olmoDelegates.js'
import { pmAgentDelegate } from '../pmAgent.js'
import { architectAgentDelegate } from '../architectAgent.js'
import { directorAgentDelegate } from '../directorAgent.js'
import { producerAgentDelegate } from '../producerAgent.js'

describe('buildOlmoDelegates', () => {
  it('returns all four delegates when agentName is "olmo" (exact)', () => {
    const requestContext = new RequestContext<TenantContext>()
    requestContext.set('agentName', 'Olmo')
    const delegates = buildOlmoDelegates({ requestContext })
    expect(delegates).toEqual({
      pm: pmAgentDelegate,
      architect: architectAgentDelegate,
      director: directorAgentDelegate,
      producer: producerAgentDelegate,
    })
  })

  it('is case-insensitive on agentName', () => {
    const requestContext = new RequestContext<TenantContext>()
    requestContext.set('agentName', 'OLMO')
    expect(Object.keys(buildOlmoDelegates({ requestContext }))).toHaveLength(4)
  })

  it('returns no delegates for a different row name (e.g. Research Engineer)', () => {
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
