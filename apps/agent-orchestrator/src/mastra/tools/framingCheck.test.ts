// Same camera as the original (user, 2026-10-17: "camera angle still same issue we fixed"). Photos and clips
// from any model came out closer or shifted and no check saw it; this compares where the person sits.
import { describe, it, expect } from 'vitest'
import { compareFraming } from './framingCheck.js'

describe('compareFraming', () => {
  it('the same size and place passes', () => {
    expect(compareFraming([0.3, 0.2, 0.7, 0.8], [0.31, 0.21, 0.69, 0.82]).ok).toBe(true)
  })
  it('much bigger in the frame is a closer camera', () => {
    const r = compareFraming([0.3, 0.2, 0.7, 0.8], [0.1, 0.02, 0.9, 0.98])
    expect(r.ok).toBe(false)
    expect(r.why).toMatch(/fills 96% of the frame height, the original 60%: the camera is closer/)
  })
  it('much smaller is a camera further away', () => {
    expect(compareFraming([0.2, 0.1, 0.8, 0.9], [0.4, 0.3, 0.6, 0.7]).why).toMatch(/the camera is further away/)
  })
  it('shifted sideways or up and down is a moved camera', () => {
    expect(compareFraming([0.3, 0.2, 0.7, 0.8], [0.05, 0.2, 0.45, 0.8]).why).toMatch(/further left in the frame/)
    expect(compareFraming([0.3, 0.2, 0.7, 0.8], [0.3, 0.35, 0.7, 0.95]).why).toMatch(/lower in the frame/)
  })
  it('a missing box is unknown, never a pass', () => {
    expect(compareFraming(undefined, [0.3, 0.2, 0.7, 0.8]).ok).toBeNull()
  })
  // fan run real7 (2026-10-17): a blade over her head in the original cut her box short, and the remake's
  // end photo, same camera, failed as "the camera is closer".
  it('a head hidden in either picture leaves the size unknown, never a fail', () => {
    const r = compareFraming([0.03, 0.31, 1, 0.985], [0.07, 0.16, 1, 0.998], { refHead: false, gotHead: true })
    expect(r.ok).toBeNull()
    expect(r.why).toMatch(/partly hidden/)
  })
  it('a hidden head still catches a camera moved sideways', () => {
    expect(compareFraming([0.3, 0.31, 0.7, 0.9], [0.0, 0.2, 0.4, 0.9], { refHead: false }).ok).toBe(false)
  })
})
