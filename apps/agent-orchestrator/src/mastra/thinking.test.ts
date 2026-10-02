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

  it('treats a one-letter typo of a long approval word as approval', () => {
    for (const typo of ['apprve', 'aprove', 'approev', 'appprove', 'retyr', 'rerty', 'procede', 'confrim', 'apprve it']) {
      expect(getThinkingBudget(typo), typo).toBe(1024)
    }
  })

  it('treats everyday yes-replies, with or without punctuation, as approval', () => {
    for (const reply of ['all', 'go ahead', 'do it', 'fine', 'okay', 'perfect', 'lets go', "let's go", 'yeah', 'yep', 'haan', 'theek hai', 'approve!', 'yes.', 'ok 👍', 'Go ahead!!']) {
      expect(getThinkingBudget(reply), reply).toBe(1024)
    }
  })

  it('never stretches typo tolerance to short or ordinary words', () => {
    for (const word of ['no', 'lol', 'hi', 'thanks', 'great', 'nice', 'hello', 'noted', 'cool']) {
      expect(getThinkingBudget(word), word).toBe(0)
    }
  })

  it('gives a bare question mark default budget, but not other punctuation', () => {
    expect(getThinkingBudget('??')).toBe(1024)
    expect(getThinkingBudget(' ? ')).toBe(1024)
    expect(getThinkingBudget('...')).toBe(0)
  })

  it('returns 8192 for messages with complex keywords', () => {
    expect(getThinkingBudget('please write a PRD for this feature')).toBe(8192)
  })

  it('returns 1024 as the default for an ordinary question', () => {
    expect(getThinkingBudget('what time does the store open')).toBe(1024)
  })
})
