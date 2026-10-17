import { describe, it, expect } from 'vitest'
import { brandInstructionBlock } from '../brandBlock.js'
import type { TenantBrand } from '../../brand/types.js'

const brand: TenantBrand = {
  name: 'Mamaearth', oneLiner: 'Toxin-free skincare.', audience: 'Women 22-35 in Indian cities', region: 'IN',
  toneWords: ['warm', 'caring'], emojiPolicy: 'minimal', signaturePhrases: ['Goodness Inside'], bannedPhrases: ['cheap'],
  ctaExamples: ['Shop now'], voiceNotes: '## What we avoid\n- Discount-speak', colors: { primary: '#00A651' },
  headlineFont: 'Poppins', logoFileId: 'f1', fontFileId: null,
}

describe('brandInstructionBlock', () => {
  it('lists the saved brand and the rule that one-off changes are not saved', () => {
    const b = brandInstructionBlock(brand)
    expect(b).toContain('## Your brand')
    expect(b).toContain('Mamaearth')
    expect(b).toContain('Never use: "cheap"')
    expect(b).toContain('primary #00A651')
    expect(b).toContain('India')
    expect(b).toMatch(/one piece of work.*never changes the saved brand/i)
    expect(b).toContain('update_brand')
  })

  it('mentions the logo only when there is one', () => {
    expect(brandInstructionBlock(brand)).toContain('noLogo')
    expect(brandInstructionBlock({ ...brand, logoFileId: null })).not.toContain('noLogo')
  })

  it('without a brand, tells Olmo how to set one up', () => {
    const b = brandInstructionBlock(null)
    expect(b).toContain('no saved brand')
    expect(b).toContain('import_brand')
    expect(b).toContain('ask_clarifying_questions')
  })

  it('shows a saved brand with no name and asks for the name', () => {
    const b = brandInstructionBlock({ ...brand, name: null })
    expect(b).not.toContain('no saved brand')
    expect(b).toContain('Name: not saved yet — ask for it')
    expect(b).toContain('Never use: "cheap"')
  })

  it('treats a row with nothing saved as no brand', () => {
    const empty: TenantBrand = {
      name: '  ', oneLiner: null, audience: null, region: 'IN', toneWords: [], emojiPolicy: 'minimal',
      signaturePhrases: [], bannedPhrases: [], ctaExamples: [], voiceNotes: null, colors: {}, headlineFont: null,
      logoFileId: null, fontFileId: null,
    }
    expect(brandInstructionBlock(empty)).toContain('no saved brand')
    expect(brandInstructionBlock({ ...empty, bannedPhrases: ['cheap'] })).not.toContain('no saved brand')
  })

  it('lists what is still missing and says to ask once before the next ad', () => {
    const b = brandInstructionBlock({ ...brand, audience: null, toneWords: [] })
    expect(b).toContain('Still missing: who it is for, how it sounds.')
    expect(b).toMatch(/ask for these once in a single ask_clarifying_questions call/)
    expect(brandInstructionBlock(brand)).not.toContain('Still missing')
  })

  it('tells Olmo to confirm set-up and ask only about what the import missed', () => {
    for (const b of [brandInstructionBlock(null), brandInstructionBlock(brand)]) {
      expect(b).toMatch(/status "done", tell the user their brand is set up/)
      expect(b).toMatch(/If "missing" is not empty, ask about all of it in one ask_clarifying_questions call/)
    }
    expect(brandInstructionBlock(null)).toMatch(/ask if anything should change/)
  })
})

