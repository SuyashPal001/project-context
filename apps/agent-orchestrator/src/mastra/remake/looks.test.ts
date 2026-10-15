import { describe, it, expect } from 'vitest'
import { remakeLooks, refuseReason, personIn, bodyChanged, aspectOf } from './looks.js'
import { breakdown, body } from './fixtures.testing.js'

describe('remakeLooks', () => {
  it('uses the measured spans and guide frames when the pose was measured', () => {
    const [a, b] = remakeLooks(breakdown())
    expect([a.startS, a.endS, a.guideStartS, a.guideEndS]).toEqual([0, 4.1, 0.2, 3.9])
    expect(b.startS).toBe(4.1)
    expect(b.guideStartS).toBeCloseTo(4.6) // no key frames: start + min(0.5, span/4)
  })
  it('needs an end still when the look has moves or the body changes, not otherwise', () => {
    const [a, b] = remakeLooks(breakdown())
    expect(a.needsEndStill).toBe(false)
    expect(b.needsEndStill).toBe(true)
  })
  it('carries the measured people count, including no person', () => {
    const b = breakdown()
    b.pose!.looks[0] = { ...b.pose!.looks[0], people: 0, no_person: true, main_start: null, main_end: null }
    const [a] = remakeLooks(b)
    expect(a.noPerson).toBe(true)
    expect(personIn(a)).toBe(false)
  })
})

describe('refuseReason', () => {
  it('refuses a watch-only breakdown before any spend', () => {
    expect(refuseReason(breakdown({ watch_only: true }))).toMatch(/upload the video file/)
  })
  it('refuses when body readings are missing', () => {
    expect(refuseReason(breakdown({ pose: null }))).toMatch(/try again/)
  })
  it('refuses split screen plainly', () => {
    const b = breakdown(); b.overview.layout = 'split screen'
    expect(refuseReason(b)).toMatch(/Split-screen/)
  })
  it('accepts a measured full-frame breakdown', () => {
    expect(refuseReason(breakdown())).toBeNull()
  })
  it('never names internals', () => {
    for (const b of [breakdown({ watch_only: true }), breakdown({ pose: null })]) {
      expect(refuseReason(b)).not.toMatch(/gemini|download|server|ai-service|gateway|yt-dlp/i)
    }
  })
})

describe('bodyChanged / aspectOf', () => {
  it('a raised arm is a change; identical readings are not', () => {
    expect(bodyChanged(body(), body())).toBe(false)
    expect(bodyChanged(body(), body({ arms: { left: 'down', right: 'raised' } }))).toBe(true)
    expect(bodyChanged(null, body())).toBe(false)
  })
  it('maps the reference shape to an output shape', () => {
    expect(aspectOf(breakdown())).toBe('9:16')
    expect(aspectOf(breakdown({ video: { ...breakdown().video, width: 1920, height: 1080 } }))).toBe('16:9')
  })
})
