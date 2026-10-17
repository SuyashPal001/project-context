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
  })  // fan run real17: a blade over her head cut the original's box top while her head still read as seen
  it('body length (shoulders to ankles) decides the size when both pictures have it', () => {
    expect(compareFraming([0.03, 0.31, 1, 0.985], [0.07, 0.16, 1, 0.998], { refLen: 0.46, gotLen: 0.45 }).ok).toBe(true)
    expect(compareFraming([0.3, 0.2, 0.7, 0.8], [0.3, 0.2, 0.7, 0.8], { refLen: 0.4, gotLen: 0.6 }).why).toMatch(/the camera is closer/)
  })  // fan run real20: an open cape to the frame edge moved the box centre; her body had not moved
  it('the body midpoint decides where she lies when both pictures have it', () => {
    expect(compareFraming([0.157, 0.171, 0.988, 0.966], [0.069, 0.171, 0.818, 0.99], { refMid: [0.47, 0.56], gotMid: [0.49, 0.57] }).ok).toBe(true)
    expect(compareFraming([0.3, 0.2, 0.7, 0.8], [0.3, 0.2, 0.7, 0.8], { refMid: [0.5, 0.5], gotMid: [0.3, 0.5] }).why).toMatch(/further left/)
  })  // fan run real29: crossed legs shortened shoulders-to-ankles; the torso decides when both have it
  it('the torso length decides the size over the body length', () => {
    expect(compareFraming([0.3, 0.2, 0.7, 0.8], [0.3, 0.2, 0.7, 0.8], { refLen: 0.41, gotLen: 0.48, refTorso: 0.2, gotTorso: 0.205 }).ok).toBe(true)
    expect(compareFraming([0.3, 0.2, 0.7, 0.8], [0.3, 0.2, 0.7, 0.8], { refTorso: 0.2, gotTorso: 0.3 }).why).toMatch(/the camera is closer/)
  })
})
