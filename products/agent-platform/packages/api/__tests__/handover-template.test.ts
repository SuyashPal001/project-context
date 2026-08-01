import { describe, it, expect } from 'vitest'
import { SECTION_TEMPLATE, seedSections } from '../lib/handover-template'

describe('SECTION_TEMPLATE', () => {
  it('defines the five closeout sections in presentation order', () => {
    expect(SECTION_TEMPLATE.map((s) => s.kind)).toEqual([
      'delivered',
      'credentials',
      'training',
      'support',
      'signoff',
    ])
  })

  it('gives every section a title, subtitle, and eyebrow', () => {
    for (const section of SECTION_TEMPLATE) {
      expect(section.title.length).toBeGreaterThan(0)
      expect(section.subtitle.length).toBeGreaterThan(0)
      expect(section.eyebrow.length).toBeGreaterThan(0)
    }
  })

  it('assigns sortOrder matching array position', () => {
    SECTION_TEMPLATE.forEach((section, i) => {
      expect(section.sortOrder).toBe(i)
    })
  })

  it('hides the credentials section, because credential storage is not built yet', () => {
    const credentials = SECTION_TEMPLATE.find((s) => s.kind === 'credentials')!
    expect(credentials.isVisible).toBe(false)
  })

  it('makes every other section visible', () => {
    for (const section of SECTION_TEMPLATE.filter((s) => s.kind !== 'credentials')) {
      expect(section.isVisible).toBe(true)
    }
  })
})

describe('seedSections', () => {
  it('returns one row per template section', () => {
    expect(seedSections()).toHaveLength(5)
  })

  it('returns a fresh array that callers cannot use to mutate the template', () => {
    const first = seedSections()
    first[0].title = 'Mutated'
    expect(seedSections()[0].title).toBe(SECTION_TEMPLATE[0].title)
    expect(SECTION_TEMPLATE[0].title).not.toBe('Mutated')
  })
})
