import { describe, it, expect } from 'vitest'
import { directorAgent, directorAgentDelegate } from '../directorAgent.js'
import { producerAgent, producerAgentDelegate } from '../producerAgent.js'

describe('delegate variants omit their own memory config', () => {
  // `memory` is a private field on @mastra/core's Agent (`#memory`), not a public
  // property — there is nothing to read via `(agent as any).memory`, on either
  // variant, regardless of configuration. `hasOwnMemory()` is the public,
  // typed accessor for exactly this check (see agent.d.ts).
  //
  // Scope of what this file proves: these are CONFIG assertions. They verify
  // the delegates declare no memory of their own and the standalone agents do
  // — nothing more. They deliberately do not claim the delegated call runs
  // memory-inert at runtime, because it does not: Mastra lends the
  // supervisor's memory to a memory-less delegate and scopes it by a
  // model-influenced resource id. See architectAgent.ts's delegate comment for
  // the mechanism and mastra/memory.ts's getMastraMemory() for the
  // thread-scoping that is the actual mitigation. Runtime behaviour is covered
  // by the manual Studio/trace check in the design doc, not here.
  it('directorAgentDelegate has no memory, directorAgent keeps its own', () => {
    expect(directorAgentDelegate.hasOwnMemory()).toBe(false)
    expect(directorAgent.hasOwnMemory()).toBe(true)
  })

  it('producerAgentDelegate has no memory, producerAgent keeps its own', () => {
    expect(producerAgentDelegate.hasOwnMemory()).toBe(false)
    expect(producerAgent.hasOwnMemory()).toBe(true)
  })

  it('delegate variants keep the same description as their standalone counterpart', () => {
    expect(directorAgentDelegate.getDescription()).toBe(directorAgent.getDescription())
    expect(producerAgentDelegate.getDescription()).toBe(producerAgent.getDescription())
  })

  it('directorAgent and directorAgentDelegate both expose retrieve_template', async () => {
    const standaloneTools = await directorAgent.listTools()
    const delegateTools = await directorAgentDelegate.listTools()
    expect(Object.keys(standaloneTools)).toContain('retrieve_template')
    expect(Object.keys(delegateTools)).toContain('retrieve_template')
  })
})
