import { describe, it, expect } from 'vitest'
import { SKILL_CREATION_CONTRACT } from '../platformAgent.js'
import { SKILL_CONTENT_QUALITY_BAR } from '../../../skills/generationPrompt.js'

describe('SKILL_CREATION_CONTRACT', () => {
  it('requires a user-given name before drafting', () => {
    expect(SKILL_CREATION_CONTRACT).toContain('Never invent one yourself')
  })

  it('requires draft_skill before save_skill, and user approval between them', () => {
    expect(SKILL_CREATION_CONTRACT).toContain('Call draft_skill')
    expect(SKILL_CREATION_CONTRACT).toContain('Only after they approve')
    expect(SKILL_CREATION_CONTRACT).toContain('NEVER ask the user to write or paste SKILL.md/YAML content themselves')
  })

  it('includes the same content-quality bar the Generate path uses', () => {
    expect(SKILL_CREATION_CONTRACT).toContain(SKILL_CONTENT_QUALITY_BAR)
  })
})
