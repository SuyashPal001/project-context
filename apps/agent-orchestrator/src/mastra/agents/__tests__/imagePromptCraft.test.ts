import { describe, it, expect } from 'vitest'
import { IMAGE_PROMPT_CRAFT } from '../imagePromptCraft.js'

describe('IMAGE_PROMPT_CRAFT', () => {
  it('carries the rules that fix known bad prompts', () => {
    expect(IMAGE_PROMPT_CRAFT).toContain('Never add characters, props, brand names')
    expect(IMAGE_PROMPT_CRAFT).toContain('empty quality tags')
    expect(IMAGE_PROMPT_CRAFT).toContain('ALWAYS pass aspectRatio')
    expect(IMAGE_PROMPT_CRAFT).toContain('referenceFileIds')
  })

  it('does not contain internal delegate or tool-routing wording that could leak to the user', () => {
    expect(IMAGE_PROMPT_CRAFT).not.toMatch(/agent-director|agent-producer/)
  })

  it('stays a rules block, not a template dump', () => {
    expect(IMAGE_PROMPT_CRAFT.length).toBeLessThan(10_000)
  })
})
