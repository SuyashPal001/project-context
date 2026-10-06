import { describe, expect, it, vi } from 'vitest'
vi.mock('./askClarifyingQuestions.js', () => ({ askClarifyingQuestionsTool: { execute: vi.fn() } }))
import { reviewOutcome } from './reviewShots.js'
import { firstShotUnreviewed, markShotReviewed, briefIsReviewedAdFlow, AD_FLOW_KEY } from './reviewGate.js'

const shots = [
  { fileId: '11111111-1111-4111-8111-111111111111', label: 'Scene 1' },
  { fileId: '22222222-2222-4222-8222-222222222222', label: 'Scene 2' },
  { fileId: '33333333-3333-4333-8333-333333333333', label: 'Scene 3' },
]

describe('review_shots outcome', () => {
  it('continues on the first shot when it looks good', () => {
    expect(reviewOutcome('still', [shots[0]], { selectedLabel: 'Looks good — continue (Recommended)' }).decision).toBe('continue')
  })
  it('fixes only the scenes the user picked, a still by an edit', () => {
    const o = reviewOutcome('still', shots, { selectedLabels: ['Scene 3'], freeText: 'extra arm on the bed' })
    expect(o.decision).toBe('fix')
    expect(o.fix.map((f) => f.label)).toEqual(['Scene 3'])
    expect(o.nextStep).toContain('edit_image')
    expect(o.nextStep).toContain('extra arm on the bed')
    expect(o.nextStep).not.toContain('Scene 2')
  })
  it('a note on the first shot without "looks good" is a fix', () => {
    expect(reviewOutcome('clip', [shots[0]], { freeText: 'she switches hands' }).decision).toBe('fix')
  })
  it('all good continues', () => {
    expect(reviewOutcome('clip', shots, { selectedLabels: ['All good — continue (Recommended)'] }).decision).toBe('continue')
  })
})

describe('first one first gate', () => {
  const ctx = (extra: Record<string, unknown> = {}) => ({ conversationId: 'conv-gate', [AD_FLOW_KEY]: true, allowMode: 'ask', ...extra })
  it('holds a batch until the first one is reviewed, in Ask mode ad flows only', () => {
    expect(firstShotUnreviewed(ctx(), 'still', 2)).toBe(true)
    expect(firstShotUnreviewed(ctx(), 'still', 1)).toBe(false)
    expect(firstShotUnreviewed(ctx({ allowMode: 'auto' }), 'still', 3)).toBe(false)
    expect(firstShotUnreviewed(ctx({ [AD_FLOW_KEY]: false }), 'still', 3)).toBe(false)
    markShotReviewed('conv-gate', 'still')
    expect(firstShotUnreviewed(ctx(), 'still', 2)).toBe(false)
    expect(firstShotUnreviewed(ctx(), 'clip', 2)).toBe(true)
  })
  it('knows an ad flow from the brief', () => {
    expect(briefIsReviewedAdFlow('flow: ugc ad\n\nMake scene 1')).toBe(true)
    expect(briefIsReviewedAdFlow('make a logo')).toBe(false)
  })
})
