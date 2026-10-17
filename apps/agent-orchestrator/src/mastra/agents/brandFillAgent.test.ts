import { describe, it, expect } from 'vitest'
import { clampFill, type BrandFillOutput } from './brandFillAgent.js'

const base: BrandFillOutput = {
  name: 'Glowroot', oneLiner: 'Plant skincare.', audience: 'Women 20-35',
  region: 'IN', toneWords: ['warm', 'caring'], emojiPolicy: 'minimal',
  signaturePhrases: ['Goodness Inside'], ctaExamples: ['Shop now'],
  voiceNotes: '## What we say', colors: { primary: '#00A651', secondary: '', accent: '', text: '', background: '', muted: '' },
  headlineFont: 'Poppins',
}

describe('clampFill', () => {
  it('leaves well-formed output untouched', () => {
    expect(clampFill(base)).toEqual(base)
  })

  it('truncates single string fields to the API limits', () => {
    const out = clampFill({
      ...base,
      name: 'x'.repeat(100),
      oneLiner: 'y'.repeat(250),
      audience: 'z'.repeat(400),
      voiceNotes: 'v'.repeat(3100),
      headlineFont: 'f'.repeat(70),
    })
    expect(out.name.length).toBe(80)
    expect(out.oneLiner.length).toBe(200)
    expect(out.audience.length).toBe(300)
    expect(out.voiceNotes.length).toBe(3000)
    expect(out.headlineFont.length).toBe(60)
  })

  it('drops (never truncates) over-length array items, keeping short ones verbatim', () => {
    const tooLong = 'p'.repeat(90)
    const out = clampFill({ ...base, signaturePhrases: ['Goodness Inside', tooLong], ctaExamples: [tooLong, 'Shop now'] })
    expect(out.signaturePhrases).toEqual(['Goodness Inside'])
    expect(out.ctaExamples).toEqual(['Shop now'])
  })

  it('caps array item counts', () => {
    const out = clampFill({
      ...base,
      toneWords: ['a', 'b', 'c', 'd', 'e', 'f'],
      signaturePhrases: Array.from({ length: 15 }, (_, i) => `phrase ${i}`),
      ctaExamples: Array.from({ length: 15 }, (_, i) => `cta ${i}`),
    })
    expect(out.toneWords.length).toBe(5)
    expect(out.signaturePhrases.length).toBe(10)
    expect(out.ctaExamples.length).toBe(10)
  })
})

describe('brandFillOutputSchema', () => {
  // The shape Gemini actually returned on the first live import (fitnearn, 2026-10-16):
  // no name, voiceNotes as an object of sections. That failed the whole import.
  it('accepts a missing name and an object voiceNotes, turning the sections into markdown', async () => {
    const { brandFillOutputSchema } = await import('./brandFillAgent.js')
    const parsed = brandFillOutputSchema.parse({
      oneLiner: 'Fitness classes', audience: 'Working adults', region: 'IN', toneWords: ['upbeat'],
      emojiPolicy: 'minimal', signaturePhrases: [], ctaExamples: ['Book now'],
      voiceNotes: { 'What we say': ['Real results', 'No shortcuts'], 'What we avoid': 'Crash diets' },
      colors: { primary: '#00A651' }, headlineFont: 'Poppins',
    })
    expect(parsed.name).toBe('')
    expect(parsed.voiceNotes).toBe('## What we say\n- Real results\n- No shortcuts\n\n## What we avoid\n- Crash diets')
    expect(parsed.colors).toMatchObject({ primary: '#00A651', secondary: '' })
  })

  it('falls back on unknown enums and missing lists instead of failing', async () => {
    const { brandFillOutputSchema } = await import('./brandFillAgent.js')
    const parsed = brandFillOutputSchema.parse({ name: 'X', region: 'India', emojiPolicy: 'lots' })
    expect(parsed).toMatchObject({ region: 'IN', emojiPolicy: 'minimal', toneWords: [], ctaExamples: [], oneLiner: '' })
  })
})
