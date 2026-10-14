import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mergeBounds, fillMissingShots, breakDownVideo } from './breakDownVideo.js'

const watch = vi.fn()
const ai = vi.fn()
const describeShots = vi.fn()
const checkShort = vi.fn()
vi.mock('./fetchVideo.js', () => ({ fetchVideo: vi.fn(async () => ({ fileId: 'f', filePath: '/m/a.mp4', durationS: 14.9, width: 720, height: 1280, fps: 30, hasAudio: true, caption: null, youtubeUrl: null, platform: 'instagram', tooLong: false })) }))
vi.mock('./watchVideo.js', () => ({ watchVideo: (...a: unknown[]) => watch(...a) }))
vi.mock('./aiServiceClient.js', () => ({ aiService: (...a: unknown[]) => ai(...a) }))
vi.mock('./describeShots.js', () => ({ describeShots: (...a: unknown[]) => describeShots(...a) }))
vi.mock('./checkShortShots.js', () => ({ checkShortShots: (...a: unknown[]) => checkShort(...a) }))

const ctx = { idToken: 't', scopeId: 's', conversationId: 'c' }
const overview = (styles: string[], looks = 4) => ({ change_style: styles, looks: Array.from({ length: looks }, (_, i) => ({ label: `l${i}`, approx_start_s: i * 3, approx_end_s: i * 3 + 2 })), subject_box: null })

beforeEach(() => {
  watch.mockReset(); ai.mockReset(); describeShots.mockReset(); checkShort.mockReset()
  describeShots.mockResolvedValue({ shots: [], sound_arc: '' })
  checkShort.mockResolvedValue({ checked: 0, status: 'ok', fixes: [] })
})

describe('mergeBounds', () => {
  it('merges cuts, hidden cuts and fade starts, dropping near-duplicates', () => {
    expect(mergeBounds(10, [2, 5], [5.3, 7], [9])).toEqual([0, 2, 5, 7, 9, 10])
    expect(mergeBounds(10, [2, 2.1], [], [])).toEqual([0, 2, 10])
  })
})

describe('fillMissingShots', () => {
  it('always uses the measured boundaries, never the model’s own times (review I1)', () => {
    const shots = fillMissingShots([0, 1.5, 4], [{ n: 1, start_s: 0, end_s: 2.2, subject: 'a', action: 'x' }, { n: 2, start_s: 2.2, end_s: 4, subject: 'b', action: 'y' }])
    expect(shots.map((s) => [s.start_s, s.end_s])).toEqual([[0, 1.5], [1.5, 4]])
    expect(shots[0].subject).toBe('a')
  })
  it('keeps every segment even when the model skipped some', () => {
    const shots = fillMissingShots([0, 1, 2, 3], [{ n: 2, start_s: 1, end_s: 2, subject: 'x', action: 'y' }])
    expect(shots.map((s) => s.n)).toEqual([1, 2, 3])
    expect(shots[0].subject).toBe('unclear')
  })
})

describe('breakDownVideo', () => {
  it('runs hidden-cut detection only when the overview says hidden_changes', async () => {
    watch.mockResolvedValue(overview(['hard_cuts'], 20))
    ai.mockImplementation(async (route: string) => route === '/media/cuts' ? { cuts: [1, 2, 3], fades: [], duration_s: 14.9 } : { curve_db: [], events: [], rhythm: [], silent_from_s: null, bpm: null, beats_s: [], has_audio: true })
    await breakDownVideo({ url: 'https://www.facebook.com/reel/1' }, ctx)
    expect(ai.mock.calls.map((c) => c[0])).not.toContain('/media/hidden-cuts')
  })
  it('uses hidden cuts as shot bounds for a hidden-change video', async () => {
    watch.mockResolvedValue(overview(['hidden_changes']))
    ai.mockImplementation(async (route: string) => {
      if (route === '/media/cuts') return { cuts: [], fades: [], duration_s: 14.9 }
      if (route === '/media/hidden-cuts') return { hidden_cuts: [{ from: 'l0', to: 'l1', at_s: 5.43, covered_s: [4.5, 6.1] }], cover_threshold: 0.6 }
      return { curve_db: [], events: [], rhythm: [], silent_from_s: null, bpm: null, beats_s: [], has_audio: true }
    })
    await breakDownVideo({ url: 'https://www.instagram.com/p/x/' }, ctx)
    expect(describeShots.mock.calls[0][1]).toEqual([0, 5.43, 14.9])
  })
  it('still returns the overview, marked unmeasured, when ai-service is down', async () => {
    watch.mockResolvedValue(overview(['hard_cuts']))
    ai.mockRejectedValue(new Error('ai-service 502'))
    const b = await breakDownVideo({ url: 'https://x.com/a/status/1' }, ctx)
    expect(b.measured).toBe(false)
    expect(b.overview.change_style).toEqual(['hard_cuts'])
    expect(b.warnings.join(' ')).toMatch(/ai-service/)
  })
  it('keeps the paid overview and measurements when describing shots fails (review M3)', async () => {
    watch.mockResolvedValue(overview(['hard_cuts']))
    ai.mockImplementation(async (route: string) => route === '/media/cuts' ? { cuts: [2, 5], fades: [], duration_s: 14.9 } : { curve_db: [], events: [], rhythm: [], silent_from_s: null, bpm: null, beats_s: [], has_audio: true })
    describeShots.mockRejectedValueOnce(new Error('gateway 502'))
    const b = await breakDownVideo({ url: 'https://x.com/a/status/1' }, ctx)
    expect(b.shots.map((s) => s.subject)).toEqual(['unclear', 'unclear', 'unclear'])
    expect(b.warnings.join(' ')).toMatch(/shot descriptions unavailable/)
  })
  it('a near-still video becomes one shot without calling describe_shots', async () => {
    watch.mockResolvedValue(overview(['near_still'], 1))
    ai.mockImplementation(async (route: string) => route === '/media/cuts' ? { cuts: [], fades: [], duration_s: 19 } : { curve_db: [], events: [], rhythm: [], silent_from_s: null, bpm: null, beats_s: [], has_audio: true })
    const b = await breakDownVideo({ url: 'https://lnkd.in/p/x' }, ctx)
    expect(describeShots).not.toHaveBeenCalled()
    expect(b.shots).toHaveLength(1)
  })
})
