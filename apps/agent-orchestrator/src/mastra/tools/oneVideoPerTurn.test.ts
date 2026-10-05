import { describe, it, expect } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { isReviewedAdFlow, markCheckFailed, markVideoMade, videoBlockedThisTurn } from './oneVideoPerTurn.js'

const brief = (text: string) => [{ role: 'user', content: { parts: [{ type: 'text', text }] } }]

describe('one video per turn in reviewed ad flows', () => {
  it('blocks a second video in the same turn of a talking-head or UGC ad', () => {
    const ctx = new RequestContext()
    expect(videoBlockedThisTurn(ctx)).toBe(false)
    markVideoMade(ctx, brief('flow: talking head\nGenerate Part 1'))
    expect(videoBlockedThisTurn(ctx)).toBe(true)
    // requireApproval sees a plain-object view of the same context
    expect(videoBlockedThisTurn({ videoMadeThisTurn: true })).toBe(true)
  })

  it('never blocks outside those flows, and a new turn starts clean', () => {
    const ctx = new RequestContext()
    markVideoMade(ctx, brief('make a video of a sunset'))
    expect(videoBlockedThisTurn(ctx)).toBe(false)
    const next = new RequestContext()
    expect(videoBlockedThisTurn(next)).toBe(false)
  })

  it('finds the marker anywhere in the run, including after an approval resume', () => {
    expect(isReviewedAdFlow([{ role: 'assistant', content: 'x' }, ...brief('FLOW: UGC AD\nscenes')])).toBe(true)
    expect(isReviewedAdFlow(undefined)).toBe(false)
  })

  it('covers every ad flow that renders video, including the animated story ad', () => {
    for (const m of ['flow: first frame', 'flow: animation character ad', 'flow: short drama stitch', 'flow: tvc ad']) {
      expect(isReviewedAdFlow(brief(m))).toBe(true)
    }
  })

  it('in Auto mode a good video does not stop the run, but a failed check does', () => {
    const ctx = new RequestContext()
    ctx.set('allowMode', 'auto')
    markVideoMade(ctx, brief('flow: ugc ad'))
    expect(videoBlockedThisTurn(ctx)).toBe(false)
    markCheckFailed(ctx, brief('flow: ugc ad'))
    expect(videoBlockedThisTurn(ctx)).toBe(true)
  })

  it('a failed check outside an ad flow changes nothing', () => {
    const ctx = new RequestContext()
    markCheckFailed(ctx, brief('make a video of a sunset'))
    expect(videoBlockedThisTurn(ctx)).toBe(false)
  })
})
