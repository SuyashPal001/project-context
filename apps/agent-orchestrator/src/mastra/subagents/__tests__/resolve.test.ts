import { describe, it, expect } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import type { TenantContext } from '../../context.js'
import { resolveDelegates } from '../resolve.js'

function ctx(entries: Partial<TenantContext>): RequestContext<TenantContext> {
  const rc = new RequestContext<TenantContext>()
  for (const [k, v] of Object.entries(entries)) rc.set(k as keyof TenantContext, v as never)
  return rc
}

describe('resolveDelegates', () => {
  it('returns every spec for the built-in host at depth 0', () => {
    const delegates = resolveDelegates({ requestContext: ctx({ agentName: 'Olmo', isBuiltInAgent: true }) })
    expect(Object.keys(delegates).sort()).toEqual(['architect', 'director', 'pm', 'producer'])
  })

  it('returns every spec for a renamed built-in host — origin gates, not name', () => {
    const delegates = resolveDelegates({ requestContext: ctx({ agentName: 'Ogo', isBuiltInAgent: true }) })
    expect(Object.keys(delegates).sort()).toEqual(['architect', 'director', 'pm', 'producer'])
  })

  it('returns an empty map once depth has reached the host ceiling', () => {
    expect(resolveDelegates({ requestContext: ctx({ agentName: 'Olmo', isBuiltInAgent: true, delegationDepth: 1 }) })).toEqual({})
  })

  it('returns an empty map for a delegate host, which cannot re-delegate', () => {
    expect(resolveDelegates({ requestContext: ctx({ agentName: 'director', delegationDepth: 1 }) })).toEqual({})
  })

  it('returns an empty map for an unrelated agent row', () => {
    expect(resolveDelegates({ requestContext: ctx({ agentName: 'Research Engineer' }) })).toEqual({})
  })

  it('keeps ungated specs even when the allowed set is empty', () => {
    // No code spec sets requiresEntitlement today, so this asserts the filter
    // is inert rather than wrong: an allowed set that omits everything must
    // still return the ungated specs.
    const delegates = resolveDelegates({ requestContext: ctx({ agentName: 'Olmo', isBuiltInAgent: true, allowedSubAgents: [] }) })
    expect(Object.keys(delegates).sort()).toEqual(['architect', 'director', 'pm', 'producer'])
  })

  it('fails open when the allowed set is unset', () => {
    expect(Object.keys(resolveDelegates({ requestContext: ctx({ agentName: 'Olmo', isBuiltInAgent: true }) }))).toHaveLength(4)
  })

  it('returns an empty map when the context itself is undefined', () => {
    expect(resolveDelegates({ requestContext: undefined })).toEqual({})
  })
})
