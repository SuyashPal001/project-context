// Live Snitch run 0a0a1c35 (2026-10-16), replayed locally on the real checker: every still was
// rejected for reasons the remake caused itself, not for bad images.
import { describe, it, expect, vi } from 'vitest'
import { stillPrompt } from './prompts.js'
import { writePlan, referenceOf } from './plan.js'
import { comparePose } from './poseCompare.js'
import { personWords } from '../tools/videoBreakdown/measuredLine.js'
import { LEAD_FACE_QUESTION } from '../tools/tvcChecks.js'
import { breakdown, body } from './fixtures.testing.js'

const brand = { name: 'Bubbli', product: 'Bubbli soda' }

describe('setting carries no camera framing', () => {
  // The reel-wide "framing: full body … then close-up … sprint shot" sat in the setting, went into
  // every still prompt, and the prompt check blocked each still for contradicting its own shot.
  const b = () => breakdown({ overview: { ...breakdown().overview, setting: { floor: 'tiled platform', light: 'fluorescent', framing: 'full body shot, then a close-up sprint shot' } } })
  it('referenceOf leaves framing out of the setting', () => {
    const s = referenceOf(b()).setting
    expect(s).toContain('tiled platform')
    expect(s).not.toMatch(/framing|close-up|sprint/)
  })
  it('a still prompt has no reel-wide framing words', async () => {
    const p = await writePlan(b(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    expect(stillPrompt(p, p.looks[0], 'start', brand, false)).not.toMatch(/sprint shot|close-up/)
  })
})

describe('legs out of shot are not described or compared', () => {
  // Look 2 start was measured "waist up" yet said "knees bent, feet to image-left": the image
  // model drew a full body, then the pose check failed it on knees it could not see.
  const waist = body({ framing: 'waist_up', knees: 'bent', feet_toward: 'image-left', knees_toward: 'image-right' })
  it('personWords drops knee and feet words when the legs are out of frame', () => {
    const w = personWords(waist, null).join(', ')
    expect(w).toContain('waist up')
    expect(w).not.toMatch(/knee|feet/)
  })
  it('knees-up framing keeps knees but drops feet', () => {
    const w = personWords(body({ framing: 'knees_up', knees: 'bent', feet_toward: 'image-left', knees_toward: 'image-right' }), null).join(', ')
    expect(w).toMatch(/knees bent/)
    expect(w).not.toMatch(/feet/)
  })
  it('comparePose ignores knees when the reference shows no legs', () => {
    const r = comparePose(waist, 1, { people: 1, main: body({ framing: 'chest_up', knees: 'straight', knees_toward: 'center' }) } as never)
    expect(r.status).toBe('pass')
  })
})

describe('accessories are not identity', () => {
  it('the still prompt keeps the guide frame accessories out', async () => {
    const p = await writePlan(breakdown(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    expect(stillPrompt(p, p.looks[0], 'start', brand, false)).toMatch(/not its person, face, outfit, accessories/)
  })
  it('the face check judges face and hair, not glasses', () => {
    expect(LEAD_FACE_QUESTION).toMatch(/glasses/)
  })
})

describe('knee side fails only when the legs are far from the reference', () => {
  // Snitch look 1 start: a walking stride at -0.091 failed a still at -0.017 on the "center" label.
  // The fan reel's alternating sides (0.148, -0.059, 0.104, -0.207) must still be held.
  const stride = body({ knees_toward: 'image-left', leg_offset: -0.091 })
  it('a label flip near the center line is not a mismatch', () => {
    expect(comparePose(stride, 1, { people: 1, main: body({ knees_toward: 'center', leg_offset: -0.017 }) } as never).status).toBe('pass')
  })
  it('a lying pose on the wrong side still fails (fan reel look 1 end)', () => {
    expect(comparePose(body({ knees_toward: 'image-right', leg_offset: 0.148 }), 1, { people: 1, main: body({ knees_toward: 'image-left', leg_offset: -0.05 }) } as never).status).toBe('fail')
  })
  it('a clear lean still has to match', () => {
    const lunge = body({ framing: 'knees_up', knees: 'bent', knees_toward: 'image-right', leg_offset: 0.457 })
    expect(comparePose(lunge, 1, { people: 1, main: body({ framing: 'knees_up', knees: 'bent', knees_toward: 'image-left', leg_offset: -0.3 }) } as never).status).toBe('fail')
  })
  it('a measured leg side is still said in words, however small', () => {
    expect(personWords(body({ knees_toward: 'image-left', leg_offset: -0.059 }), null).join(', ')).toMatch(/knees fall to image-left/)
  })
})

describe('trick objects stay out of stills; objects are placed from the picture', () => {
  // Fan reel: the blade was drawn into every still at a different angle, and "beside her on the rug,
  // then in her left hand" drew two remotes (and got one prompt blocked).
  const b = () => breakdown({ overview: { ...breakdown().overview, props: [
    { prop: 'remote control', where: 'beside her on the rug, then in her left hand', when: 'all' },
    { prop: 'ceiling fan blade', where: 'foreground, sweeping across the lens', when: 'at each change', part_of_trick: true },
  ] } as never })
  it('referenceOf keeps the trick flag', () => {
    expect(referenceOf(b()).props.map((p) => !!p.trick)).toEqual([false, true])
  })
  it('the still names scene objects without timed positions, and says not to draw the trick object', async () => {
    const p = await writePlan(b(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    const s = stillPrompt(p, p.looks[0], 'start', brand, false)
    expect(s).toContain('Objects: remote control.')
    expect(s).not.toMatch(/then in her left hand/)
    expect(s).toMatch(/where objects sit/)
    expect(s).toMatch(/Do not draw: ceiling fan blade/)
  })
  it('the prompt check is not told the trick object is in the frame', async () => {
    const { stillGateInput } = await import('./prompts.js')
    const p = await writePlan(b(), brand, vi.fn().mockResolvedValue({ lines: [] }))
    expect(stillGateInput(p, p.looks[0], 'start', 'x').startFrameObjects).toEqual(['remote control'])
  })
})
