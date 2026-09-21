import { describe, it, expect } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { platformAgent } from '../platformAgent.js'

describe('platformAgent instructions — talking-head contract', () => {
  it('composes the TALKING_HEAD_CONTRACT section into instructions', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Base override text.')
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)

    expect(text).toContain('## Talking-head ad — intake, narration lock, and delivery')
  })

  it('routes single-continuous-presenter requests away from the UGC character contract', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Base override text.')
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)

    const ugcIdx = text.indexOf('## UGC character ad')
    expect(ugcIdx).toBeGreaterThanOrEqual(0)
    // The UGC contract's own trigger line must now explicitly route a
    // single-continuous-presenter request to the talking-head contract
    // instead, so the two contracts' trigger conditions don't overlap.
    const ugcTriggerLine = text.slice(ugcIdx, ugcIdx + 600)
    expect(ugcTriggerLine).toContain('Talking-head ad contract')
  })

  it('narration lock — the contract requires locking BOTH fileId and durationSeconds, and restating them on every later delegation', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Base override text.')
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)

    const talkingHeadIdx = text.indexOf('## Talking-head ad')
    expect(talkingHeadIdx).toBeGreaterThanOrEqual(0)
    const section = text.slice(talkingHeadIdx, talkingHeadIdx + 2500)

    expect(section).toContain('Locked Reference Artifact IDs')
    expect(section).toContain('durationSeconds')
    expect(section).toMatch(/[Rr]estate this locked narration fileId and durationSeconds/)
    expect(section).toContain('Never re-delegate a fresh generate_narration call')
  })

  it('states the up-front multi-confirmation cost warning and the board gate', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Base override text.')
    const instructions = await platformAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)

    const talkingHeadIdx = text.indexOf('## Talking-head ad')
    const nextSectionIdx = text.indexOf('\n\n## ', talkingHeadIdx + 1)
    const section = text.slice(talkingHeadIdx, nextSectionIdx > 0 ? nextSectionIdx : undefined)

    expect(section).toMatch(/8-10 separate cost confirmations/)
    expect(section).toMatch(/present them together and ask the user to approve the set as a whole/)
    expect(section).toMatch(/deliberate visible cut/)
  })
})
