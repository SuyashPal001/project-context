import { describe, it, expect } from 'vitest'
import {
  mergeInvokedSkills,
  MAX_INVOKED_SKILLS,
  buildSkillInvocationPrepareStep,
  invokedSkillsInstruction,
  mergeSkillSets,
  type InvokedSkill,
} from '../skillInvocation.js'

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

describe('buildSkillInvocationPrepareStep', () => {
  it('forces the skill tool for exactly as many steps as skills were invoked', () => {
    const prepareStep = buildSkillInvocationPrepareStep(2)!
    expect(prepareStep({ stepNumber: 0 } as Parameters<typeof prepareStep>[0])).toEqual({ toolChoice: { type: 'tool', toolName: 'skill' } })
    expect(prepareStep({ stepNumber: 1 } as Parameters<typeof prepareStep>[0])).toEqual({ toolChoice: { type: 'tool', toolName: 'skill' } })
    expect(prepareStep({ stepNumber: 2 } as Parameters<typeof prepareStep>[0])).toBeUndefined()
  })

  it('returns no prepareStep at all on a turn with no invocation', () => {
    expect(buildSkillInvocationPrepareStep(0)).toBeUndefined()
  })
})

describe('invokedSkillsInstruction', () => {
  it('names the skills the forced steps must load', () => {
    const text = invokedSkillsInstruction(['ugc-ad-production', 'design-taste'])
    expect(text).toContain('ugc-ad-production, design-taste')
    expect(text).toContain('skill tool')
  })

  it('adds nothing on a turn with no invocation', () => {
    expect(invokedSkillsInstruction([])).toBe('')
  })
})

describe('mergeSkillSets', () => {
  it('keeps attached skills first and lists a skill that is both attached and invoked once', () => {
    const merged = mergeSkillSets([{ name: 'a' }, { name: 'b' }], [{ name: 'b' }, { name: 'c' }])
    expect(merged.map((s) => s.name)).toEqual(['a', 'b', 'c'])
  })
})
