// A shot longer than one clip (8s) was left as a still (Snitch shot 2: 12.4s). It is now split into
// equal continuous parts; each later part starts from the previous part's end still (no jump at the
// join, no extra paid still there).
import { describe, it, expect, vi } from 'vitest'
import { lookSpans } from '../tools/videoBreakdown/breakDownVideo.js'
import { remakeLooks } from './looks.js'
import { breakdown, body } from './fixtures.testing.js'

describe('long shots become continuous parts', () => {
  it('lookSpans splits a 12.4s shot into two equal parts', () => {
    const o = { looks: [{ label: 'run', approx_start_s: 3.4, approx_end_s: 15.8 }] } as never
    expect(lookSpans(o, [], 15.85)).toEqual([{ label: 'run', start_s: 3.4, end_s: 9.6 }, { label: 'run · part 2', start_s: 9.6, end_s: 15.8 }])
  })
  it('an 8s shot stays whole', () => {
    expect(lookSpans({ looks: [{ label: 'a', approx_start_s: 0, approx_end_s: 8 }] } as never, [], 8)).toHaveLength(1)
  })
  const twoParts = () => {
    const b = breakdown()
    const pl = b.pose!.looks[0]
    return breakdown({
      overview: { ...b.overview, looks: [{ ...b.overview.looks[0], label: 'run', approx_start_s: 0, approx_end_s: 12 }] },
      cuts: { cuts: [], fades: [], duration_s: 12 },
      pose: { ...b.pose!, moves: [], looks: [{ ...pl, label: 'run', start_s: 0, end_s: 6 }, { ...pl, label: 'run · part 2', start_s: 6, end_s: 12 }] },
    } as never)
  }
  it('a later part continues; the part before it gets an end still', () => {
    const looks = remakeLooks(twoParts())
    expect(looks.map((l) => [l.n, l.ref, !!l.continues, l.needsEndStill])).toEqual([[1, 0, false, true], [2, 0, true, expect.any(Boolean)]])
  })
  it('the workflow reuses part 1\'s end still as part 2\'s start, without paying for it', async () => {
    const { continueParts } = await import('./workflow.js')
    const looks = remakeLooks(twoParts())
    const stills = [{ look: 1, kind: 'start' as const, fileId: 's1', status: 'passed' as const, reasons: [] }, { look: 1, kind: 'end' as const, fileId: 'e1', status: 'passed' as const, reasons: [], tries: [{ fileId: 'e1', kept: true, why: [], creditsMicro: '100' }] }]
    const out = continueParts(looks, stills)
    expect(out.find((s) => s.look === 2 && s.kind === 'start')).toEqual({ look: 2, kind: 'start', fileId: 'e1', status: 'passed', reasons: [] })
  })
})
void vi; void body
