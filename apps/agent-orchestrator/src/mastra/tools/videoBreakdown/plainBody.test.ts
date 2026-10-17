// The pose in plain fashion words, for image and video models (user, 2026-10-17: "just ask it simple, pose of
// legs... left or right"). Measured words like "knees fall to image-left, feet to image-right" twisted her legs.
import { describe, it, expect } from 'vitest'
import { plainBody } from './measuredLine.js'

const b = (o: Record<string, unknown> = {}) => ({ framing: 'full_body', orientation: 'vertical', torso_angle_deg: 0, knees: 'straight', arms: { left: 'down', right: 'down' }, knees_toward: 'center', feet_toward: 'center', legs_toward: 'center', leg_offset: 0, knee_offset: 0, feet_offset: 0, facing: 'front', frames: 1, ...o }) as never

describe('plainBody', () => {
  it('legs together, their side, and soft knees', () => {
    expect(plainBody(b({ legs_toward: 'image-left', knees: 'bent' }))).toBe('full body, legs long and together, swept to the left, knees softly bent')
    expect(plainBody(b())).toBe('full body, legs long and together, straight')
  })
  it('a raised arm and a back to the camera are said plainly; no jargon', () => {
    const s = plainBody(b({ arms: { left: 'raised', right: 'down' }, facing: 'back', legs_toward: 'image-right', knees_toward: 'image-right', feet_toward: 'image-left' }))
    expect(s).toBe('full body, back to the camera, legs long and together, swept to the right, left arm raised')
    expect(s).not.toMatch(/image-|fall to|upright|feet to/)
  })
})
