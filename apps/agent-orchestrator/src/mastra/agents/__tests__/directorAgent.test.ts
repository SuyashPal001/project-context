import { describe, it, expect } from 'vitest'
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
