import { describe, it, expect } from 'vitest'
import { TEMPLATES } from './creative-templates'

describe('creative template seed data', () => {
  it('has exactly the 6 expected slugs', () => {
    expect(TEMPLATES.map(t => t.slug).sort()).toEqual([
      'before-after', 'offer', 'problem-solution', 'product-demo', 'testimonial', 'ugc-review',
    ])
  })

  it.each(TEMPLATES.map(t => [t.slug, t] as const))('%s has a non-empty scenes array with sequential order', (_slug, template) => {
    expect(template.scenes.length).toBeGreaterThan(0)
    expect(template.scenes.map(s => s.order)).toEqual(
      Array.from({ length: template.scenes.length }, (_, i) => i + 1),
    )
  })

  it.each(TEMPLATES.map(t => [t.slug, t] as const))('%s has valid technical keys', (_slug, template) => {
    expect(template.technical.aspectRatio).toMatch(/^\d+:\d+$/)
    expect(template.technical.durationSeconds).toBeGreaterThan(0)
    expect(template.technical.resolution).toMatch(/^\d+x\d+$/)
    expect(template.technical.fps).toBeGreaterThan(0)
  })

  it.each(TEMPLATES.map(t => [t.slug, t] as const))('%s has non-empty clone/exclude fields', (_slug, template) => {
    expect(template.clonePrompt.length).toBeGreaterThan(0)
    expect(template.negativePrompt.length).toBeGreaterThan(0)
    expect(template.cloneNotes.length).toBeGreaterThan(0)
    expect(template.excludeInClone.length).toBeGreaterThan(0)
  })
})
