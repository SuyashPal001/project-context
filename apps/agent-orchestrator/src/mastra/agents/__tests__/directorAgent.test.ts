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

  it('has generate_narration, lipsync, and assemble_clips registered, needed for talking-head', async () => {
    const directorTools = await directorAgent.listTools()
    const delegateTools = await directorAgentDelegate.listTools()
    expect(Object.keys(directorTools)).toEqual(
      expect.arrayContaining(['generate_narration', 'lipsync', 'assemble_clips']),
    )
    expect(Object.keys(delegateTools)).toEqual(
      expect.arrayContaining(['generate_narration', 'lipsync', 'assemble_clips']),
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
    expect(text).toContain('## Talking-head generation')
  })

  it('talking-head section never tells Director to read narration data from its own working memory, and covers the sub-3s clip floor / aspectRatio findings', async () => {
    const requestContext = new RequestContext()
    const instructions = await directorAgent.getInstructions({ requestContext })
    const text = typeof instructions === 'string' ? instructions : JSON.stringify(instructions)
    const talkingHeadStart = text.indexOf('## Talking-head generation')
    expect(talkingHeadStart).toBeGreaterThanOrEqual(0)
    const talkingHeadSection = text.slice(talkingHeadStart)

    // Regression guard for review finding 1: Director-as-delegate has no
    // memory of its own, so it cannot "read from working memory" — it must
    // rely on values restated in Olmo's delegation message.
    expect(talkingHeadSection).not.toContain('from working memory')
    expect(talkingHeadSection).toContain('Olmo gave you in this delegation message')

    // Finding 4: front-loading must never produce a sub-3-second clip.
    expect(talkingHeadSection).toContain('NEVER let any clip')
    expect(talkingHeadSection).toContain('below 3 seconds')

    // Finding 5: Assembly bullet must mention aspectRatio.
    const assemblyIdx = talkingHeadSection.indexOf('- Assembly:')
    expect(assemblyIdx).toBeGreaterThanOrEqual(0)
    expect(talkingHeadSection.slice(assemblyIdx, assemblyIdx + 400)).toContain('aspectRatio')

    // Finding 2: narration language passthrough.
    expect(talkingHeadSection).toContain('language')
  })
})
