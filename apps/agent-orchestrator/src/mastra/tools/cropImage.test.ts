import { describe, it, expect } from 'vitest'
import { computeCropRect, computeZoomRect, parseHeadBox } from './cropImage.js'

describe('computeCropRect', () => {
  it('frames a 3:4 head-and-shoulders crop around the head of a full-body still', () => {
    const r = computeCropRect(1024, 1536, 'close-up', { x: 0.42, y: 0.1, w: 0.12, h: 0.1 })
    expect(Math.abs(r.w / r.h - 3 / 4)).toBeLessThan(0.01)
    // the head is inside the crop, with room above it
    expect(r.y).toBeLessThan(0.1 * 1536)
    expect(r.y + r.h).toBeGreaterThan((0.1 + 0.1) * 1536)
    expect(r.x).toBeLessThan(0.42 * 1024)
    expect(r.x + r.w).toBeGreaterThan((0.42 + 0.12) * 1024)
  })

  it('makes a half-body crop taller than a close-up', () => {
    const head = { x: 0.42, y: 0.1, w: 0.12, h: 0.1 }
    expect(computeCropRect(1024, 1536, 'half-body', head).h).toBeGreaterThan(computeCropRect(1024, 1536, 'close-up', head).h)
  })

  it('stays inside the image near the edges, with even dimensions', () => {
    const r = computeCropRect(800, 1000, 'half-body', { x: 0.9, y: 0, w: 0.1, h: 0.3 })
    expect(r.x).toBeGreaterThanOrEqual(0)
    expect(r.y).toBeGreaterThanOrEqual(0)
    expect(r.x + r.w).toBeLessThanOrEqual(800)
    expect(r.y + r.h).toBeLessThanOrEqual(1000)
    expect(r.w % 2).toBe(0)
    expect(r.h % 2).toBe(0)
  })

  it('falls back to the top-centre without a head box', () => {
    const r = computeCropRect(1024, 1536, 'close-up', null)
    expect(r.y).toBeLessThan(0.06 * 1536)
    expect(Math.abs(r.x + r.w / 2 - 512)).toBeLessThan(2)
  })
})

describe('parseHeadBox', () => {
  it('reads fractions out of the model reply', () => {
    expect(parseHeadBox('```json\n{"x":0.4,"y":0.08,"w":0.15,"h":0.11}\n```')).toEqual({ x: 0.4, y: 0.08, w: 0.15, h: 0.11 })
  })

  it('rejects pixels, out-of-range or missing values', () => {
    expect(parseHeadBox('{"x":400,"y":80,"w":150,"h":110}')).toBeNull()
    expect(parseHeadBox('{"x":0.9,"y":0.1,"w":0.3,"h":0.1}')).toBeNull()
    expect(parseHeadBox('no face found')).toBeNull()
  })
})

describe('computeCropRect keepAspect', () => {
  it('keeps a 9:16 source 9:16 when given its aspect', () => {
    const r = computeCropRect(1080, 1920, 'close-up', { x: 0.4, y: 0.2, w: 0.2, h: 0.12 }, 1080 / 1920)
    expect(Math.abs(r.w / r.h - 9 / 16)).toBeLessThan(0.01)
    expect(r.x).toBeGreaterThanOrEqual(0)
    expect(r.y + r.h).toBeLessThanOrEqual(1920)
  })
})

describe('head box parsing and video-frame zoom (2026-10-03 cap-crop bug)', () => {
  it("reads gemini-3.6-flash's native box_2d answer", () => {
    const box = parseHeadBox('```json\n[\n  {"box_2d": [222, 227, 563, 695], "label": "head"}\n]\n```')
    expect(box).toEqual({ x: 0.227, y: 0.222, w: 0.468, h: 0.341 })
  })
  it('zooms around the face and keeps the whole head in frame', () => {
    const r = computeZoomRect(768, 1376, 'close-up', { x: 0.35, y: 0.25, w: 0.3, h: 0.2 })!
    expect(Math.abs(r.w / r.h - 768 / 1376)).toBeLessThan(0.01)
    expect(r.y).toBeLessThanOrEqual(0.25 * 1376)
    expect(r.y + r.h).toBeGreaterThanOrEqual(0.45 * 1376)
  })
  it('refuses (returns null) without a head box instead of guessing', () => {
    expect(computeZoomRect(768, 1376, 'close-up', null)).toBeNull()
  })
})
