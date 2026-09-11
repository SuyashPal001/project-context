import { describe, it, expect } from 'vitest'
import { mergeInvokedSkills, MAX_INVOKED_SKILLS, type InvokedSkill } from '../skillInvocation.js'

const skill = (n: number): InvokedSkill => ({ installId: `install-${n}`, skillId: `skill-${n}`, name: `Skill ${n}` })

describe('mergeInvokedSkills', () => {
  it('adds newly picked skills after the existing ones', () => {
    const { merged, newlyInvoked } = mergeInvokedSkills([skill(1)], [skill(2)])
    expect(merged).toEqual([skill(1), skill(2)])
    expect(newlyInvoked).toEqual([skill(2)])
  })

  it('does not re-invoke a skill already on in the conversation', () => {
    const { merged, newlyInvoked } = mergeInvokedSkills([skill(1)], [skill(1)])
    expect(merged).toEqual([skill(1)])
    expect(newlyInvoked).toEqual([])
  })

  it('dedupes within one message', () => {
    const { newlyInvoked } = mergeInvokedSkills([], [skill(1), skill(1)])
    expect(newlyInvoked).toEqual([skill(1)])
  })

  it(`caps the conversation at ${MAX_INVOKED_SKILLS}, keeping the existing ones`, () => {
    const existing = Array.from({ length: 7 }, (_, i) => skill(i))
    const { merged, newlyInvoked } = mergeInvokedSkills(existing, [skill(100), skill(101)])
    expect(merged).toHaveLength(MAX_INVOKED_SKILLS)
    expect(newlyInvoked).toEqual([skill(100)])
  })
})
