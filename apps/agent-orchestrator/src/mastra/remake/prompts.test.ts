import { describe, it, expect, vi } from 'vitest'
import { castSheetPrompt, stillPrompt, stillGateInput, usesProduct } from './prompts.js'
import { writePlan, applyEdits } from './plan.js'
import { precheckPrompt } from '../scorers/video/promptCheck.js'
import { breakdown } from './fixtures.testing.js'

const brand = { name: 'Bubbli', product: 'Bubbli soda', audience: 'students' }
const plan = async () => applyEdits(await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] })), [
  { ref: 'looks[0].outfit', action: 'swap', to: 'yellow tee with a Bubbli soda can in hand' },
  { ref: 'props[0]', action: 'swap', to: 'a Bubbli soda can' },
], brand)

describe('stillPrompt', () => {
  it('is built from plan lines: swapped outfit, kept expression, measured body words, pose-only guide', async () => {
    const p = await plan()
    const s = stillPrompt(p, p.looks[0], 'start', brand, false)
    expect(s).toContain('yellow tee with a Bubbli soda can in hand')
    expect(s).not.toContain('red dress')
    expect(s).toContain('mouth closed')
    expect(s).toMatch(/Copy ONLY the body pose, camera framing, setting and where objects sit from the second image/) // setting kept
    expect(s).toMatch(/full body/)
    expect(s).toContain('Objects: a Bubbli soda can.')
    expect(s).toMatch(/Add nothing that is not described here/)
  })
  it('adds no smile to a closed-mouth look (the prompt pre-check passes)', async () => {
    const p = await plan()
    const s = stillPrompt(p, p.looks[0], 'start', brand, false)
    expect(precheckPrompt(s, { expression: p.looks[0].expression })).toEqual([])
  })
  it('uses the end pose and end body for an end still', async () => {
    const p = await plan()
    expect(stillPrompt(p, p.looks[1], 'end', brand, false)).toContain('Pose: stands')
    expect(stillPrompt(p, p.looks[1], 'start', brand, false)).toContain('Pose: sits')
  })
  it('a no-person look has no person sentence and a layout-only guide', async () => {
    const b = breakdown(); b.pose!.looks[0] = { ...b.pose!.looks[0], people: 0, no_person: true, main_start: null, main_end: null }
    const p = await writePlan(b, brand, vi.fn().mockResolvedValue({ lines: [] }))
    const s = stillPrompt(p, p.looks[0], 'start', brand, false)
    expect(s).toMatch(/No person in this image/)
    expect(s).toMatch(/Copy ONLY the layout and camera angle from the first image/)
    expect(s).not.toMatch(/same face/)
  })
  it('names the product photo only when there is one and a line uses the product', async () => {
    const p = await plan()
    expect(usesProduct(p, brand)).toBe(true)
    expect(stillPrompt(p, p.looks[0], 'start', brand, true)).toMatch(/third image is the brand's product/)
    expect(stillPrompt(p, p.looks[0], 'start', brand, false)).not.toMatch(/third image/)
  })
  it('drops a dropped prop and never uses the reference on-screen text', async () => {
    const p = applyEdits(await plan(), [{ ref: 'props[0]', action: 'drop', why: 'no' }], brand)
    const s = stillPrompt(p, p.looks[0], 'start', brand, false)
    expect(s).not.toMatch(/remote|soda can \(left\)/)
    expect(s).not.toContain('SALE')
  })
})

describe('castSheetPrompt', () => {
  it('asks for three new, different people and no real person', () => {
    const s = castSheetPrompt('a woman in her 20s, sporty')
    expect(s).toMatch(/three equal side-by-side panels/)
    expect(s).toContain('a woman in her 20s, sporty')
    expect(s).toMatch(/Not any real or famous person/)
  })
})

describe('stillGateInput', () => {
  it('carries the look lines and the visible objects, and no moments (a still has no action)', async () => {
    const p = await plan()
    const g = stillGateInput(p, p.looks[0], 'start', 'PROMPT')
    expect(g.planLine).toContain('looks[0].outfit: swap to yellow tee')
    expect(g.startFrameObjects).toEqual(['a Bubbli soda can'])
    expect(g.keyMoments).toEqual([])
    expect(g.look.expression).toBe('mouth closed')
  })
})

describe('the guide image and the setting line agree (real checker, 2026-10-16)', () => {
  it('a KEPT setting is copied from the guide image, not excluded from it', async () => {
    const p = await plan() // setting: keep (auto)
    const s = stillPrompt(p, p.looks[0], 'start', brand, false)
    expect(s).toMatch(/Copy ONLY the body pose, camera framing, setting and where objects sit from the second image; not its person, face, outfit, accessories or any text/)
  })
  it('a SWAPPED setting is excluded from the guide image', async () => {
    const p = applyEdits(await plan(), [{ ref: 'setting', action: 'swap', to: 'a bright cafe' }], brand)
    const s = stillPrompt(p, p.looks[0], 'start', brand, false)
    expect(s).toMatch(/Copy ONLY the body pose, camera framing and where objects sit from the second image; not its person, face, outfit, accessories, setting or any text/)
    expect(s).toMatch(/Setting: a bright cafe/)
  })
})
