// A photographer's direction for each look, from the original's own frames (user, 2026-10-17: "acceptable not
// exceptional"; "she keeps the remote in her hand"; "not comfortable posing"). v12's poses were directed per look
// ("one hand resting on her chest, one knee bent over the other leg"; "the remote stays still on the rug").
import { describe, it, expect, vi } from 'vitest'
import { lookDirection, followsDirection, LOOK_DIRECTION_QUESTION } from './lookDirection.js'

const img = (d: string) => ({ data: d, mime: 'image/jpeg' })

describe('lookDirection', () => {
  it('asks with the look\'s frames in order and the objects to place, and returns the direction', async () => {
    const ask = vi.fn().mockResolvedValue({ start: 'one hand resting on her chest, legs crossed at the ankles', moves: 'she slowly slides both legs to the image-right', objects: 'the black remote lies on the rug beside her left hand' })
    const d = await lookDirection(ask, [img('a'), img('b'), img('c')], ['Remote control'])
    expect(d).toEqual({ start: 'one hand resting on her chest, legs crossed at the ankles', moves: 'she slowly slides both legs to the image-right', objects: 'the black remote lies on the rug beside her left hand' })
    const parts = ask.mock.calls[0][0]
    expect(parts.filter((p: { image?: unknown }) => p.image)).toHaveLength(3)
    expect(parts.at(-1).text).toMatch(/Remote control/)
  })
  it('no answer or no start is null, never a made-up direction', async () => {
    expect(await lookDirection(vi.fn().mockRejectedValue(new Error('x')), [img('a')], [])).toBeNull()
    expect(await lookDirection(vi.fn().mockResolvedValue({ moves: 'x' }), [img('a')], [])).toBeNull()
  })
  it('the question asks for a photographer\'s direction with image-side words', () => {
    const q = LOOK_DIRECTION_QUESTION(['Remote control'])
    expect(q).toMatch(/how a photographer would direct the model/)
    expect(q).toMatch(/image-left|image-right/)
  })
})

// fan run real28: look 3's photo kept the remote in her hand though the direction put it on the rug, and look 4's
// legs were not crossed as directed; nothing checked a photo against its direction.
describe('followsDirection', () => {
  const d = { start: 'one hand on her midriff, left leg crossed over the right', moves: '', objects: 'the black remote lies on the rug left of her torso' }
  it('a photo that differs from its direction fails, saying what differs', async () => {
    const ask = vi.fn().mockResolvedValue({ pose_matches: false, objects_match: false, differs: 'her legs are not crossed; the remote is in her hand' })
    const r = await followsDirection(ask, img('p'), d)
    expect(r).toEqual({ status: 'fail', reason: 'not as directed: her legs are not crossed; the remote is in her hand' })
    expect(ask.mock.calls[0][0].at(-1).text).toMatch(/left leg crossed over the right/)
  })
  it('a match passes; no answer is unknown, never a pass', async () => {
    expect((await followsDirection(vi.fn().mockResolvedValue({ pose_matches: true, objects_match: true, differs: '' }), img('p'), d)).status).toBe('pass')
    expect((await followsDirection(vi.fn().mockRejectedValue(new Error('x')), img('p'), d)).status).toBe('unknown')
  })
})
