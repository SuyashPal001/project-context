import { describe, expect, it, vi } from 'vitest'
vi.mock('./askClarifyingQuestions.js', () => ({ askClarifyingQuestionsTool: { execute: vi.fn() } }))
import { reviewOutcome, reviewShotsTool } from './reviewShots.js'
import { askClarifyingQuestionsTool } from './askClarifyingQuestions.js'
import { firstShotUnreviewed, markShotReviewed, briefIsReviewedAdFlow, noteClipCheck, AD_FLOW_KEY } from './reviewGate.js'

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

describe('a clip the check failed', () => {
  it('is marked as needing a fix, and continuing is no longer the recommended pick', async () => {
    noteClipCheck(shots[2].fileId, false, 'Did not say the approved line (heard: "honestly you")')
    noteClipCheck(shots[1].fileId, true, 'Same person, product and line.')
    const ask = askClarifyingQuestionsTool.execute as unknown as ReturnType<typeof vi.fn>
    // The user taps scene 3, by whatever label the card showed.
    ask.mockImplementationOnce(async (input: { questions: Array<{ options: Array<{ label: string }> }> }) => ({ answers: [{ selectedLabels: [input.questions[0].options[1].label] }] }))
    const out = await (reviewShotsTool as unknown as { execute: (i: unknown, c: unknown) => Promise<{ decision: string; fix: Array<{ label: string }> }> })
      .execute({ kind: 'clip', shots: [shots[1], { ...shots[2], label: 'Scene 3 — Payoff & CTA with the price and shades line' }] }, { requestContext: new Map([['conversationId', 'c']]) })
    const q = ask.mock.calls[0][0].questions[0]
    const labels = q.options.map((o: { label: string }) => o.label)
    expect(labels[0]).toBe('Scene 2')
    expect(labels[1].startsWith('Scene 3 — Payoff')).toBe(true)
    expect(labels[1].length).toBeLessThanOrEqual(40)
    expect(labels[2]).toBe('All good — continue')
    expect(q.options[1].rationale).toContain('honestly you')
    expect(q.options[0].rationale).toBeUndefined()
    expect(out.decision).toBe('fix')
  })
  it('one failed clip recommends fixing it', () => {
    expect(reviewOutcome('clip', [shots[0]], { selectedLabel: 'Fix it (Recommended)' }).decision).toBe('fix')
    expect(reviewOutcome('clip', [shots[0]], { selectedLabel: 'Looks good — continue' }).decision).toBe('continue')
  })
})
