import { describe, it, expect } from 'vitest'
import { Agent } from '@mastra/core/agent'
import { defineSubAgent, SubAgentSpecError } from '../spec.js'

const fakeAgent = {} as Agent
const base = {
  id: 'director',
  build: () => fakeAgent,
  description: 'Generates and edits images from a text description. Not for video or copywriting.',
  tags: ['image'],
  maxSteps: 8,
  estimatedCredits: 1_000,
}

describe('defineSubAgent', () => {
  it('returns the spec with maxDepth defaulted to 0', () => {
    const spec = defineSubAgent(base)
    expect(spec.maxDepth).toBe(0)
    expect(spec.id).toBe('director')
  })

  it('rejects a description with no negative clause', () => {
    expect(() => defineSubAgent({ ...base, description: 'Generates images.' }))
      .toThrow(SubAgentSpecError)
  })

  it('accepts any of the negative-clause phrasings', () => {
    for (const tail of ['Not for video.', "Don't use for copy.", 'Never use for audio.', 'Avoid for long video.']) {
      expect(() => defineSubAgent({ ...base, description: `Makes images. ${tail}` })).not.toThrow()
    }
  })

  it('rejects maxSteps below 1', () => {
    expect(() => defineSubAgent({ ...base, maxSteps: 0 })).toThrow(/maxSteps/)
  })

  it('rejects negative estimatedCredits', () => {
    expect(() => defineSubAgent({ ...base, estimatedCredits: -1 })).toThrow(/estimatedCredits/)
  })

  it('rejects negative maxDepth', () => {
    expect(() => defineSubAgent({ ...base, maxDepth: -1 })).toThrow(/maxDepth/)
  })

  it('rejects a blank id', () => {
    expect(() => defineSubAgent({ ...base, id: '  ' })).toThrow(/id/)
  })

  it('names the offending spec in the error message', () => {
    expect(() => defineSubAgent({ ...base, description: 'Generates images.' })).toThrow(/director/)
  })
})
