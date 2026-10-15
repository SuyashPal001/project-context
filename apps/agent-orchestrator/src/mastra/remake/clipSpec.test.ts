import { describe, it, expect, vi } from 'vitest'
import { clipSpecs, clipPrompt, clipGateInput, lookFrames, CLIP_FPS } from './clipSpec.js'
import { writePlan } from './plan.js'
import { breakdown } from './fixtures.testing.js'
import type { StillResult } from './types.js'
import { precheckPrompt } from '../scorers/video/promptCheck.js'

const brand = { name: 'B', product: 'p' }
const plan = () => writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] }))
const ok = (look: number, kind: 'start' | 'end', status: StillResult['status'] = 'passed'): StillResult => ({ look, kind, fileId: `${look}${kind}`, status, reasons: [] })

describe('lookFrames', () => {
  it('sums to exactly round(total × 30)', async () => {
    const f = lookFrames(await plan())
    expect([...f.values()].reduce((a, b) => a + b, 0)).toBe(Math.round(10 * CLIP_FPS))
    expect(f.get(1)).toBe(123) // 4.1s
  })
})

describe('clipSpecs', () => {
  it('Veo between two good stills, at the smallest length that covers the look', async () => {
    const s = clipSpecs(await plan(), [ok(1, 'start'), ok(2, 'start'), ok(2, 'end')])
    expect(s[1]).toMatchObject({ engine: 'veo', seconds: 6, start: '2start', end: '2end', frames: 177 })
  })
  it('Omni from the start still when there is no usable end still', async () => {
    const s = clipSpecs(await plan(), [ok(1, 'start'), ok(2, 'start'), ok(2, 'end', 'failed')])
    expect(s[0]).toMatchObject({ engine: 'omni', seconds: 5 })
    expect(s[1]).toMatchObject({ engine: 'omni', seconds: 6, end: null })
  })
  it('no usable start still keeps the part as a still, with a plain reason', async () => {
    const s = clipSpecs(await plan(), [ok(1, 'start', 'blocked'), ok(2, 'start'), ok(2, 'end')])
    expect(s[0]).toMatchObject({ engine: 'none' })
    expect(s[0].reason).toMatch(/stays a still/)
  })
  it('a part longer than one clip stays a still and is never paid for (Review Focus 1)', async () => {
    const p = await plan()
    p.looks[1] = { ...p.looks[1], endS: 15.5 }
    p.reference.durationS = 15.5
    const s = clipSpecs(p, [ok(1, 'start'), ok(2, 'start'), ok(2, 'end')])
    expect(s[1]).toMatchObject({ engine: 'none' })
    expect(s[1].reason).toMatch(/too long/)
  })
})

describe('clipPrompt', () => {
  it('carries the measured moves with look-relative times, holds the camera, adds nothing', async () => {
    const p = await plan()
    const s = clipPrompt(p, p.looks[1], brand, 'veo')
    expect(s).toMatch(/at 1\.9s: legs/)
    expect(s).toMatch(/image-up|up/)
    expect(s).toMatch(/The first image is the first frame and the second image is the last frame/)
    expect(s).toMatch(/Add nothing/)
    // Rule 7.1 forbids ADDING an expression, not keeping one: look b's kept expression is "smiles".
    expect(s.match(/Expression: smiles/g)).toHaveLength(1)
    expect(precheckPrompt(clipPrompt(p, p.looks[0], brand, 'omni'), { expression: p.looks[0].expression })).toEqual([])
  })
  it('Omni prompts say the image is the first frame and there is no last frame', async () => {
    const p = await plan()
    expect(clipPrompt(p, p.looks[0], brand, 'omni')).toMatch(/The image is the exact first frame/)
  })
  it('the gate gets the moments inside the look', async () => {
    const p = await plan()
    expect(clipGateInput(p, p.looks[1], 'X').keyMoments).toEqual(['stands up'])
    expect(clipGateInput(p, p.looks[0], 'X').keyMoments).toEqual([])
  })
})
