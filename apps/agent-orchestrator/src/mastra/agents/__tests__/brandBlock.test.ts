import { describe, it, expect } from 'vitest'
import { brandInstructionBlock } from '../brandBlock.js'
import type { TenantBrand } from '../../brand/types.js'

const brand: TenantBrand = {
  name: 'Mamaearth', oneLiner: 'Toxin-free skincare.', audience: 'Women 22-35 in Indian cities', region: 'IN',
  toneWords: ['warm', 'caring'], emojiPolicy: 'minimal', signaturePhrases: ['Goodness Inside'], bannedPhrases: ['cheap'],
  ctaExamples: ['Shop now'], voiceNotes: '## What we avoid\n- Discount-speak', colors: { primary: '#00A651' },
  headlineFont: 'Poppins', logoFileId: 'f1',
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

  it('treats a row with no name as no brand', () => {
    expect(brandInstructionBlock({ ...brand, name: null })).toContain('no saved brand')
  })
})
