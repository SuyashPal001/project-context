import { describe, it, expect } from 'vitest'
import { SKILL_CREATION_CONTRACT } from '../platformAgent.js'
import { SKILL_CONTENT_QUALITY_BAR } from '../../../skills/generationPrompt.js'

describe('SKILL_CREATION_CONTRACT', () => {
  it('still tells the agent to write the file itself, never the user', () => {
    expect(SKILL_CREATION_CONTRACT).toContain('YOU write the complete SKILL.md body yourself')
    expect(SKILL_CREATION_CONTRACT).toContain('NEVER call ask_clarifying_questions to ask the user to write or paste')
  })

  it('includes the same content-quality bar the Generate path uses', () => {
    expect(SKILL_CREATION_CONTRACT).toContain(SKILL_CONTENT_QUALITY_BAR)
  })
})
