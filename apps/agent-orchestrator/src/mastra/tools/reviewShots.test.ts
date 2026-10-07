import { describe, expect, it, vi } from 'vitest'
vi.mock('./askClarifyingQuestions.js', () => ({ askClarifyingQuestionsTool: { execute: vi.fn() } }))
vi.mock('./checkClip.js', () => ({ checkClip: { execute: vi.fn() } }))
import { reviewOutcome, reviewShotsTool, shotLabel } from './reviewShots.js'
import { checkClip } from './checkClip.js'
import { askClarifyingQuestionsTool } from './askClarifyingQuestions.js'
import { firstShotUnreviewed, firstVoiceUnreviewed, noteNarrationMade, markShotReviewed, briefIsReviewedAdFlow, noteClipCheck, noteBriefRefs, briefRefsFor, noteMadeFile, AD_FLOW_KEY } from './reviewGate.js'

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

describe('stills are checked against the brief before the user sees them', () => {
  const brief = 'User direction:\ncreate an ad\nCreative brief:\n- Avatar: Hana · Beauty creator · Natural\n  Use the attached still image as the presenter reference.\n- Product: Lakmē Forever Matte Lipstick\n  Shop Lakme'
  const atts = [{ fileId: 'avatar-1', name: 'Hana' }, { fileId: 'product-1', name: 'Lakmē Forever Matte Lipstick.jpg' }]

  it('remembers the product photo and avatar from the brief', () => {
    noteBriefRefs('conv-brief', brief, atts)
    expect(briefRefsFor('conv-brief')).toMatchObject({ productFileId: 'product-1', avatarFileId: 'avatar-1' })
    noteBriefRefs('conv-plain', 'make me a logo', atts)
    expect(briefRefsFor('conv-plain')).toEqual({})
  })

  it('flags the still with the wrong product, says what to tap, and drops "Still" from labels', async () => {
    noteBriefRefs('conv-still', brief, atts)
    const check = checkClip.execute as unknown as ReturnType<typeof vi.fn>
    check.mockReset()
    check.mockImplementation(async (i: { clipFileId: string; productFileId: string }) => {
      expect(i.productFileId).toBe('product-1')
      return i.clipFileId === shots[0].fileId ? { passed: false, productMatches: false, reason: 'pink tube, not the maroon bullet' } : { passed: true, productMatches: true }
    })
    const ask = askClarifyingQuestionsTool.execute as unknown as ReturnType<typeof vi.fn>
    ask.mockReset()
    ask.mockResolvedValueOnce({ answers: [{ selectedLabels: ['All good — continue'] }] })
    await (reviewShotsTool as unknown as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute(
      { kind: 'still', question: 'Do these look good to animate?', shots: [{ ...shots[0], label: 'Scene 1 — Hook Still' }, { ...shots[1], label: 'Scene 2 — Product Benefit Still' }] },
      { requestContext: new Map([['conversationId', 'conv-still']]) },
    )
    const q = ask.mock.calls[0][0].questions[0]
    expect(q.prompt).toContain('Do these look good to animate?')
    expect(q.prompt).toContain('Tap any scene that needs a fix')
    expect(q.options[0]).toMatchObject({ label: 'Scene 1 — Hook' })
    expect(q.options[0].rationale).toContain('wrong product')
    expect(q.options[1].label).toBe('Scene 2 — Product Benefit')
    expect(q.options[1].rationale).toBeUndefined()
    expect(q.options[2].label).toBe('All good — continue')
  })

  it('shortens labels without emptying them', () => {
    expect(shotLabel('Scene 3 — Look & CTA Still')).toBe('Scene 3 — Look & CTA')
    expect(shotLabel('Scene 1 clip')).toBe('Scene 1')
    expect(shotLabel('Still')).toBe('Still')
  })
})

describe('a picture that was never made', () => {
  it('is never put to the user', async () => {
    noteMadeFile('conv-made', shots[1].fileId)
    const ask = askClarifyingQuestionsTool.execute as unknown as ReturnType<typeof vi.fn>
    ask.mockReset()
    const out = await (reviewShotsTool as unknown as { execute: (i: unknown, c: unknown) => Promise<{ decision: string; nextStep: string }> })
      .execute({ kind: 'still', shots: [shots[0]] }, { requestContext: new Map([['conversationId', 'conv-made']]) })
    expect(ask).not.toHaveBeenCalled()
    expect(out.decision).toBe('skipped')
    expect(out.nextStep).toContain('NOT_MADE')
  })
})

describe('narration: the voice is heard first, then the rest in one take (Pip ad, 2026-10-07)', () => {
  const ctx = (conv: string, extra: Record<string, unknown> = {}) => ({ conversationId: conv, [AD_FLOW_KEY]: true, allowMode: 'ask', ...extra })
  it('lets the first line through, holds the second until the voice was heard', () => {
    expect(firstVoiceUnreviewed(ctx('conv-voice'))).toBe(false)
    noteNarrationMade('conv-voice')
    expect(firstVoiceUnreviewed(ctx('conv-voice'))).toBe(true)
    expect(firstVoiceUnreviewed(ctx('conv-voice', { allowMode: 'auto' }))).toBe(false)
    expect(firstVoiceUnreviewed(ctx('conv-voice', { [AD_FLOW_KEY]: false }))).toBe(false)
    markShotReviewed('conv-voice', 'voice')
    expect(firstVoiceUnreviewed(ctx('conv-voice'))).toBe(false)
  })
  it('asks about the voice, and on continue says to make the rest as one take', async () => {
    const line = { fileId: '2852975a-fcce-4ae3-99f2-5cce91b9a84f', label: 'Narration' }
    noteMadeFile('conv-voice-ask', line.fileId)
    const ask = askClarifyingQuestionsTool.execute as unknown as ReturnType<typeof vi.fn>
    ask.mockReset()
    ask.mockResolvedValueOnce({ answers: [{ selectedLabel: 'Looks good — continue (Recommended)' }] })
    const out = await (reviewShotsTool as unknown as { execute: (i: unknown, c: unknown) => Promise<{ decision: string; nextStep: string }> })
      .execute({ kind: 'voice', shots: [line] }, { requestContext: new Map([['conversationId', 'conv-voice-ask']]) })
    const q = ask.mock.calls[0][0].questions[0]
    expect(q.prompt).toBe('Does this voice sound right? The rest of the narration is read in this voice.')
    expect(out.decision).toBe('continue')
    expect(out.nextStep).toContain('ONE generate_narration')
    expect(vi.mocked(checkClip.execute as never)).not.toHaveBeenCalledWith(expect.objectContaining({ clipFileId: line.fileId }), expect.anything())
    expect(firstVoiceUnreviewed({ conversationId: 'conv-voice-ask', [AD_FLOW_KEY]: true, allowMode: 'ask' })).toBe(false)
  })
  it('a fix remakes only the first line', () => {
    const out = reviewOutcome('voice', [{ fileId: 'f', label: 'Narration' }], { selectedLabel: 'Fix it', freeText: 'warmer, slower' })
    expect(out.decision).toBe('fix')
    expect(out.nextStep).toContain('remake ONLY the first narration line')
    expect(out.nextStep).toContain('warmer, slower')
  })
})
