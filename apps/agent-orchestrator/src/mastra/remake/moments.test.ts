// Metro reel (2026-10-16): the story's key beat, holding the phone up to the train window at 2.2s, sat in
// the middle of shot 1 (0-3.4s), between its start and end stills, so only the clip could show it. A
// moment well inside a shot now gets its own still: the shot is split there into two continuous parts
// (the second starts on the moment's still, never paid twice), each animated on its own.
import { describe, it, expect } from 'vitest'
import { remakeLooks } from './looks.js'
import { breakdown } from './fixtures.testing.js'

const withMoment = (t: number, what = 'holds the phone up against the window', beat = true) => {
  const b = breakdown()
  return breakdown({ overview: { ...b.overview, moments: [{ t_s: t, what, why_it_matters: 'the key beat', story_beat: beat }] } } as never)
}

describe('a moment inside a shot gets its own still', () => {
  it('splits the shot at the moment; the second part continues from it', () => {
    const looks = remakeLooks(withMoment(2))
    expect(looks.map((l) => [l.n, l.startS, l.endS, !!l.continues])).toEqual([[1, 0, 2, false], [2, 2, 4.1, true], [3, 4.1, 10, false]])
    expect(looks[0]).toMatchObject({ endPose: 'holds the phone up against the window', guideEndS: 2, needsEndStill: true, end: null, ref: 0 })
    expect(looks[1]).toMatchObject({ startPose: '', guideStartS: 2, start: null, ref: 0 })
  })
  it('move times are kept per part', () => {
    const b = withMoment(7)
    const looks = remakeLooks(b)
    const second = looks.find((l) => l.startS === 7)!
    expect(second.moveLines.every((m) => !/^at 1\.3s/.test(m))).toBe(true) // the 5.3s move belongs to the first part
    expect(looks.find((l) => l.endS === 7)!.moveLines.some((m) => /^at 1\.2s/.test(m))).toBe(true) // 5.3s - 4.1s
  })
  it('a small moment that is not a story beat never splits a shot', () => {
    expect(remakeLooks(withMoment(2, 'adjusts his glasses', false))).toHaveLength(2)
  })
  it('no split near a shot edge or in a shot too short for two parts', () => {
    expect(remakeLooks(withMoment(0.6))).toHaveLength(2)
    expect(remakeLooks(withMoment(3.5))).toHaveLength(2)
  })
})

// Fan rerun v8 (2026-10-16): a beat at 1.3s in a 0-5.4s shot left a 1.3s part (a 4s clip squeezed 3x);
// the remote pointed at the fan at 3.0s is the beat that should split it.
describe('each part is long enough to animate', () => {
  it('a beat that would leave a part under 2s is skipped for a later one', () => {
    const b = breakdown()
    const looks = remakeLooks(breakdown({ overview: { ...b.overview, moments: [{ t_s: 1.3, what: 'text appears', why_it_matters: 'x', story_beat: true }, { t_s: 2.1, what: 'points the remote at the fan', why_it_matters: 'x', story_beat: true }] } } as never))
    expect(looks[0]).toMatchObject({ startS: 0, endS: 2.1, endPose: 'points the remote at the fan' })
  })
})
