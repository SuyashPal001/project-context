import { describe, it, expect, afterEach } from 'vitest'
import { imageEngineFor, imageModelFor, markCreatorFlow, endCreatorFlow } from './imageEngine.js'

const ctx = (values: Record<string, unknown>) => ({ get: (k: never) => values[k as unknown as string] })

describe('imageEngineFor', () => {
  const orig = process.env.GPT_IMAGE_ENABLED
  afterEach(() => { if (orig === undefined) delete process.env.GPT_IMAGE_ENABLED; else process.env.GPT_IMAGE_ENABLED = orig })

  it('stays on Gemini while GPT Image is switched off, whatever is asked', () => {
    delete process.env.GPT_IMAGE_ENABLED
    markCreatorFlow('c-off')
    expect(imageEngineFor(ctx({ conversationId: 'c-off' }), 'gpt')).toBe('gemini')
  })

  it('uses GPT from the creator roll until the avatar is saved, then Gemini', () => {
    process.env.GPT_IMAGE_ENABLED = 'true'
    const c = ctx({ conversationId: 'c1' })
    expect(imageEngineFor(c)).toBe('gemini')
    markCreatorFlow('c1')
    expect(imageEngineFor(c)).toBe('gpt')
    endCreatorFlow('c1')
    expect(imageEngineFor(c)).toBe('gemini')
  })

  it('uses GPT when a creator skill is turned on, and an explicit choice wins', () => {
    process.env.GPT_IMAGE_ENABLED = 'true'
    expect(imageEngineFor(ctx({ conversationId: 'c2', invokedSkillNames: ['TVC character creator'] }))).toBe('gpt')
    expect(imageEngineFor(ctx({ conversationId: 'c2', invokedSkillNames: ['UGC character ad'] }))).toBe('gemini')
    expect(imageEngineFor(ctx({ conversationId: 'c2' }), 'gpt')).toBe('gpt')
  })
})

describe('imageModelFor', () => {
  it('bills a 2K GPT image under its own rate', () => {
    expect(imageModelFor('gpt', '2K')).toEqual({ model: 'gpt-image-2', rateSubject: 'gpt-image-2-2k' })
    expect(imageModelFor('gpt')).toEqual({ model: 'gpt-image-2', rateSubject: 'gpt-image-2' })
    expect(imageModelFor('gemini', '2K')).toEqual({ model: 'gemini-3-pro-image-preview', rateSubject: 'gemini-3-pro-image-preview' })
  })
})
