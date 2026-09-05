import { describe, it, expect } from 'vitest'
import { SKILL_SYSTEM_PROMPT, buildSkillPrompt } from '../generationPrompt.js'

describe('SKILL_SYSTEM_PROMPT', () => {
  // The manifest parser requires a --- YAML block with name and description.
  // If the prompt stops saying so, every generated skill fails on save, and
  // the failure surfaces two services away from the cause.
  it('states the frontmatter contract the manifest parser enforces', () => {
    expect(SKILL_SYSTEM_PROMPT).toContain('---')
    expect(SKILL_SYSTEM_PROMPT).toContain('name:')
    expect(SKILL_SYSTEM_PROMPT).toContain('description:')
  })

  it('tells the model to write for an agent, not a human reader', () => {
    expect(SKILL_SYSTEM_PROMPT.toLowerCase()).toContain('agent')
  })
})

describe('buildSkillPrompt', () => {
  it('carries the name and brief', () => {
    const prompt = buildSkillPrompt({ name: 'Bid Writer', brief: 'Help write RFP responses' })
    expect(prompt).toContain('Bid Writer')
    expect(prompt).toContain('Help write RFP responses')
  })

  it('omits the revision section when there is no previous draft', () => {
    const prompt = buildSkillPrompt({ name: 'Bid Writer', brief: 'Help write RFP responses' })
    expect(prompt).not.toContain('previous draft')
  })

  it('includes the previous draft and the feedback when revising', () => {
    const prompt = buildSkillPrompt({
      name: 'Bid Writer',
      brief: 'Help write RFP responses',
      previousDraft: '---\nname: bid-writer\ndescription: d\n---\n\nOld body.',
      feedback: 'Make it shorter',
    })
    expect(prompt).toContain('Old body.')
    expect(prompt).toContain('Make it shorter')
  })

  // A draft with no feedback is still a revision request — "try again" — and
  // must not silently look like a first generation.
  it('includes the previous draft even when feedback is absent', () => {
    const prompt = buildSkillPrompt({
      name: 'Bid Writer',
      brief: 'Help write RFP responses',
      previousDraft: '---\nname: bid-writer\ndescription: d\n---\n\nOld body.',
    })
    expect(prompt).toContain('Old body.')
  })
})
