import { describe, it, expect } from 'vitest'
import { joinFades, keepSegments, silenceThreshold, parseSilences } from './tightenPauses.js'

describe('tighten_pauses segments', () => {
  // The Naina run (2026-10-05): 0.6s silent start, a 1.3s pause before the
  // last line, a 1.6s silent smile at the end of an 18s video.
  const stderr = 'silence_start: 0\nsilence_end: 0.642521\nsilence_start: 14.074187\nsilence_end: 15.400062\nsilence_start: 16.378937\n'
  const silences = parseSilences(stderr, 18.005)

  it('reads silences, closing an open one at the end of the video', () => {
    expect(silences).toEqual([[0, 0.642521], [14.074187, 15.400062], [16.378937, 18.005]])
  })

  it('trims the edges and shortens the mid pause to a quick cut', () => {
    const keep = keepSegments(silences, 18.005)
    expect(keep).toHaveLength(2)
    expect(keep[0][0]).toBeCloseTo(0.4925, 3)
    expect(keep[0][1]).toBeCloseTo(14.1942, 3)
    expect(keep[1][0]).toBeCloseTo(15.2801, 3)
    expect(keep[1][1]).toBeCloseTo(16.8789, 3)
  })

  it('keeps a video with no silence whole', () => {
    expect(keepSegments([], 10)).toEqual([[0, 10]])
  })
})

describe('joinFades', () => {
  it('fades only the inner edges of each cut', () => {
    expect(joinFades(0, 1, 5)).toBe('')
    expect(joinFades(0, 2, 5)).toBe(',afade=t=out:st=4.980:d=0.020')
    expect(joinFades(1, 2, 3)).toBe(',afade=t=in:d=0.020')
  })
})

describe('silenceThreshold', () => {
  it('sits 5dB under the clip mean, clamped', () => {
    expect(silenceThreshold('[Parsed_volumedetect_0] mean_volume: -24.7 dB\nmax_volume: -5.6 dB')).toBe(-30)
    expect(silenceThreshold('mean_volume: -60.0 dB')).toBe(-45)
    expect(silenceThreshold('nothing')).toBe(-35)
  })
})
