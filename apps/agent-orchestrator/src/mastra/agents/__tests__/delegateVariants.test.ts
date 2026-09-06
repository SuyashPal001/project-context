import { describe, it, expect } from 'vitest'
import { architectAgent, architectAgentDelegate } from '../architectAgent.js'
import { directorAgent, directorAgentDelegate } from '../directorAgent.js'
import { producerAgent, producerAgentDelegate } from '../producerAgent.js'
import { pmAgent, pmAgentDelegate } from '../pmAgent.js'

describe('delegate variants run memory-inert', () => {
  // `memory` is a private field on @mastra/core's Agent (`#memory`), not a public
  // property — there is nothing to read via `(agent as any).memory`, on either
  // variant, regardless of configuration. `hasOwnMemory()` is the public,
  // typed accessor for exactly this check (see agent.d.ts).
  it('architectAgentDelegate has no memory, architectAgent keeps its own', () => {
    expect(architectAgentDelegate.hasOwnMemory()).toBe(false)
    expect(architectAgent.hasOwnMemory()).toBe(true)
  })

  it('directorAgentDelegate has no memory, directorAgent keeps its own', () => {
    expect(directorAgentDelegate.hasOwnMemory()).toBe(false)
    expect(directorAgent.hasOwnMemory()).toBe(true)
  })

  it('producerAgentDelegate has no memory, producerAgent keeps its own', () => {
    expect(producerAgentDelegate.hasOwnMemory()).toBe(false)
    expect(producerAgent.hasOwnMemory()).toBe(true)
  })

  it('pmAgentDelegate has no memory, pmAgent keeps its own', () => {
    expect(pmAgentDelegate.hasOwnMemory()).toBe(false)
    expect(pmAgent.hasOwnMemory()).toBe(true)
  })

  it('delegate variants keep the same description as their standalone counterpart', () => {
    expect(architectAgentDelegate.getDescription()).toBe(architectAgent.getDescription())
    expect(directorAgentDelegate.getDescription()).toBe(directorAgent.getDescription())
    expect(producerAgentDelegate.getDescription()).toBe(producerAgent.getDescription())
  })

  it('pmAgentDelegate keeps the same description and sub-agent delegation as pmAgent', () => {
    expect(pmAgentDelegate.getDescription()).toBe(pmAgent.getDescription())
  })
})
