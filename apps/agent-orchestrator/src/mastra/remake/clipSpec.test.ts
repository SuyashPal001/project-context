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
    expect(s[1]).toMatchObject({ engine: 'omni', seconds: 7, end: null }) // 5.9s + warm-up + margin (tools/clipTiming)
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
  // fan run real24 (user, 2026-10-17: "legs are so weird... keep it like left or right style, and make her face to
  // camera, like eyes"): measured words like "upright in frame, knees bent, knees fall to image-left, feet to
  // image-right" made Omni twist her legs under a long dress. The prompt says the leg side plainly and her eyes
  // on the camera.
  it('no measured body jargon in a clip prompt', async () => {
    const p = await plan()
    for (const look of p.looks) for (const e of ['veo', 'omni'] as const) {
      expect(clipPrompt(p, look, brand, e)).not.toMatch(/At the start:|At the end:|upright in frame|knees fall to|feet to image|knees (bent|straight)/)
    }
  })
  it('the legs are said plainly: lying to the left or right, and still', async () => {
    const p = await plan()
    const look = { ...p.looks[0], moveLines: [], start: { ...p.looks[0].start!, legs_toward: 'image-left' as const } }
    expect(clipPrompt(p, look, brand, 'omni')).toMatch(/Her legs lie to the left and stay still\./)
    const straight = { ...look, start: { ...look.start, legs_toward: 'center' as const } }
    expect(clipPrompt(p, straight, brand, 'omni')).toMatch(/Her legs lie straight and stay still\./)
    const moving = { ...look, moveLines: ['at 1.0s: legs moves right'] }
    expect(clipPrompt(p, moving, brand, 'omni')).not.toMatch(/stay still/)
  })
  it('her eyes look at the camera when the original faces it', async () => {
    const p = await plan()
    const front = { ...p.looks[0], start: { ...p.looks[0].start!, facing: 'front' as const } }
    expect(clipPrompt(p, front, brand, 'omni')).toMatch(/She looks straight at the camera, eyes on the lens\./)
    const back = { ...p.looks[0], start: { ...p.looks[0].start!, facing: 'back' as const } }
    expect(clipPrompt(p, back, brand, 'omni')).not.toMatch(/eyes on the lens/)
  })
  it('Omni prompts say the image is the first frame and there is no last frame', async () => {
    const p = await plan()
    expect(clipPrompt(p, p.looks[0], brand, 'omni')).toMatch(/The image is the exact first frame/)
  })
  it('the gate gets no reference moments: the stills and measured moves carry them (fan reel 2026-10-16: required moments blocked every clip)', async () => {
    const p = await plan()
    expect(clipGateInput(p, p.looks[1], 'X').keyMoments).toEqual([])
    expect(clipGateInput(p, p.looks[0], 'X').keyMoments).toEqual([])
  })
})

// Shared clip timing (user, 2026-10-16): the fan reel's 1.3s look was a 4s clip played 3x fast. A clip is
// now generated long enough and trimmed at real speed; it is retimed only when the speed-up is unnoticeable.
describe('clips keep real speed (tools/clipTiming)', () => {
  it('a short look gets the smallest Veo length that covers it and is trimmed, not sped up', async () => {
    const p = await plan()
    p.looks[0] = { ...p.looks[0], endS: 1.3 }; p.looks[1] = { ...p.looks[1], startS: 1.3 }
    const s = clipSpecs(p, [ok(1, 'start'), ok(1, 'end'), ok(2, 'start'), ok(2, 'end')])
    expect(s[0]).toMatchObject({ engine: 'veo', seconds: 4, fit: { mode: 'trim', startS: 0 } })
  })
  it('a Veo clip within the unnoticeable speed-up is retimed so its last frame stays the end still', async () => {
    const s = clipSpecs(await plan(), [ok(1, 'start'), ok(2, 'start'), ok(2, 'end')])
    expect(s[1]).toMatchObject({ engine: 'veo', seconds: 6, fit: { mode: 'retime' } })
  })
  it('a look of 4.8s gets a 6s Veo clip cut at real speed (4s would be 1.2x slow)', async () => {
    const p = await plan()
    p.looks[1] = { ...p.looks[1], endS: p.looks[1].startS + 4.8 }
    const s = clipSpecs(p, [ok(1, 'start'), ok(2, 'start'), ok(2, 'end')])
    expect(s[1]).toMatchObject({ engine: 'veo', seconds: 6, fit: { mode: 'trim', startS: 0 } })
  })
  it('an Omni clip covers its warm-up and is trimmed past it; a continuing part starts at 0', async () => {
    const p = await plan()
    const s = clipSpecs(p, [ok(1, 'start'), ok(2, 'start'), ok(2, 'end', 'failed')])
    expect(s[0]).toMatchObject({ engine: 'omni', seconds: 5, fit: { mode: 'trim', startS: 0.4 } })
    p.looks[1] = { ...p.looks[1], continues: true }
    const c = clipSpecs(p, [ok(1, 'start'), ok(1, 'end'), ok(2, 'start'), ok(2, 'end', 'failed')])
    expect(c[1].fit).toEqual({ mode: 'trim', startS: 0 })
  })
  it('a trimmed clip prompt keeps real move times and holds the end pose after the look', async () => {
    const p = await plan()
    const s = clipPrompt(p, p.looks[1], brand, 'veo', 8, false, { mode: 'trim', startS: 0 })
    expect(s).toMatch(/at 1\.9s: legs/)
    expect(s).toMatch(/Finish every move by 5\.9s, then hold that last pose/)
    const o = clipPrompt(p, p.looks[1], brand, 'omni', 7, false, { mode: 'trim', startS: 0.4 })
    expect(o).toMatch(/at 2\.3s: legs/)
  })
})

// Fan reel on the real workflow (2026-10-16): every clip was blocked before paying. The check demanded the
// reference's moments (fan blades, text appearing), which a clip never shows (text is dropped, the trick
// isn't built, the stills carry the look), and read the prompt's retimed move times as wrong.
describe('the clip prompt check reads what the clip will be', () => {
  it('no reference moments are required of a clip (like a still)', async () => {
    const p = await plan()
    p.reference.moments = [{ t_s: 5, what: 'A fan blade passes across the lens' }, { t_s: 6, what: 'text appears at bottom' }]
    expect(clipGateInput(p, p.looks[1], 'x').keyMoments).toEqual([])
  })
  it('the move times it checks are the prompt\'s own, for the clip\'s length and fit', async () => {
    const p = await plan()
    const g = clipGateInput(p, p.looks[1], 'x', 8)
    expect((g.look.moves as string[]).join(' ')).toMatch(/at 2\.6s: legs/) // 1.9s × 8/5.9, as the prompt says
    expect(String(g.look.timing)).toMatch(/clip times/)
    const t = clipGateInput(p, p.looks[1], 'x', 7, { mode: 'trim', startS: 0.4 })
    expect((t.look.moves as string[]).join(' ')).toMatch(/at 2\.3s: legs/)
  })
})

// Fan reel clips (2026-10-16): look 1 was blocked "missing: looks[0].outfit: swap to …" though a clip
// never describes the outfit: its start (and end) image shows it.
describe('the clip check knows the look comes from the images', () => {
  it('outfit lines say they are given by the start image', async () => {
    const p = await plan()
    p.lines.push({ ref: 'looks[0].outfit', action: 'swap', to: 'emerald anarkali' })
    const line = clipGateInput(p, p.looks[0], 'x').planLine
    expect(line).toMatch(/looks\[0\]\.outfit: swap to emerald anarkali \(given by the start image, not described in words\)/)
  })
})
