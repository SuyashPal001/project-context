import { describe, it, expect } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { directorAgent, directorAgentDelegate } from '../directorAgent.js'

describe('directorAgent tool registration', () => {
  it('has analyze_video and analyze_audio registered, needed for template-video-generation', async () => {
    const directorTools = await directorAgent.listTools()
    const delegateTools = await directorAgentDelegate.listTools()
    expect(Object.keys(directorTools)).toEqual(
      expect.arrayContaining(['analyze_video', 'analyze_audio']),
    )
    expect(Object.keys(delegateTools)).toEqual(
      expect.arrayContaining(['analyze_video', 'analyze_audio']),
    )
  })
})

describe('directorAgent instructions', () => {
  it('appends template-cloning, UGC-character, and motion-craft sections even under a tenant agentSystemPrompt override', async () => {
    const requestContext = new RequestContext()
    requestContext.set('agentSystemPrompt', 'Custom persona override text.')
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    expect(text).toContain('Custom persona override text.')
    expect(text).toContain('## Template cloning')
    expect(text).toContain('## UGC character generation')
    expect(text).toContain('## Motion craft')
  })
})
