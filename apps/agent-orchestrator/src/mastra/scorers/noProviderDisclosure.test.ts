import { describe, it, expect } from 'vitest'
import { containsKnownProviderName } from './noProviderDisclosure.js'

describe('containsKnownProviderName', () => {
  it('flags Google/Gemini disclosure', () => {
    expect(containsKnownProviderName('I am a large language model built by Google.')).toBe(true)
    expect(containsKnownProviderName('I run on Gemini.')).toBe(true)
  })

  it('flags Anthropic/OpenAI disclosure', () => {
    expect(containsKnownProviderName('I was trained by Anthropic.')).toBe(true)
    expect(containsKnownProviderName('Powered by OpenAI models.')).toBe(true)
  })

  it('does not flag normal replies', () => {
    expect(containsKnownProviderName("I'm Olmo, here to help with your project.")).toBe(false)
  })
})
