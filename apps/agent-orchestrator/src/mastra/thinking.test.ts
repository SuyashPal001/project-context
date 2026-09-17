import { describe, it, expect } from 'vitest'
import { getThinkingBudget } from './thinking.js'

describe('getThinkingBudget', () => {
  it('gives approval-shaped short replies default (non-zero) budget', () => {
    for (const word of ['approve', 'approved', 'yes', 'go', 'ok', 'okay', 'sure', 'looks good', 'go ahead', 'proceed', 'confirm']) {
      expect(getThinkingBudget(word)).toBe(1024)
    }
  })

  it('is case-insensitive and trims whitespace for approval signals', () => {
    expect(getThinkingBudget('  Approve  ')).toBe(1024)
    expect(getThinkingBudget('APPROVED')).toBe(1024)
  })

  it('still returns 0 for purely conversational messages that are not approval signals', () => {
    expect(getThinkingBudget('hi')).toBe(0)
    expect(getThinkingBudget('thanks')).toBe(0)
    expect(getThinkingBudget('no')).toBe(0)
  })

  it('still returns 0 for very short non-approval messages', () => {
    expect(getThinkingBudget('lol')).toBe(0)
  })

  it('returns 8192 for messages with complex keywords', () => {
    expect(getThinkingBudget('please write a PRD for this feature')).toBe(8192)
  })

  it('returns 1024 as the default for an ordinary question', () => {
    expect(getThinkingBudget('what time does the store open')).toBe(1024)
  })
})
