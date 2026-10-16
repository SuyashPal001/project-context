import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mergeBounds, fillMissingShots, breakDownVideo, breakDownLocalFile, recentBreakdown, lookSpans } from './breakDownVideo.js'
import { fetchVideo, DownloadBlocked } from './fetchVideo.js'

const watch = vi.fn()
const ai = vi.fn()
const describeShots = vi.fn()
const checkShort = vi.fn()
vi.mock('./fetchVideo.js', async (orig) => ({ FetchRefused: (await orig<any>()).FetchRefused, DownloadBlocked: (await orig<any>()).DownloadBlocked, probe: vi.fn(async () => ({ durationS: 14.9, width: 720, height: 1280, fps: 30, codec: 'h264', hasAudio: true })), fetchVideo: vi.fn(async () => ({ fileId: 'f', filePath: '/m/a.mp4', durationS: 14.9, width: 720, height: 1280, fps: 30, hasAudio: true, caption: null, youtubeUrl: null, platform: 'instagram', tooLong: false })) }))
vi.mock('./watchVideo.js', () => ({ watchVideo: (...a: unknown[]) => watch(...a) }))
vi.mock('./aiServiceClient.js', () => ({ aiService: (...a: unknown[]) => ai(...a) }))
vi.mock('./describeShots.js', () => ({ describeShots: (...a: unknown[]) => describeShots(...a) }))
const refine = vi.fn(async (...a: unknown[]) => ({ overview: a[1], refined: 0, unmeasured: 0 }))
vi.mock('./refineMoments.js', () => ({ refineMoments: (...a: unknown[]) => refine(...a) }))
vi.mock('./checkShortShots.js', () => ({ checkShortShots: (...a: unknown[]) => checkShort(...a) }))

const ctx = { idToken: 't', scopeId: 's', conversationId: 'c' }
const overview = (styles: string[], looks = 4) => ({ change_style: styles, looks: Array.from({ length: looks }, (_, i) => ({ label: `l${i}`, approx_start_s: i * 3, approx_end_s: i * 3 + 2 })), subject_box: null, moments: [] as Array<{ t_s: number; what: string; why_it_matters: string }> })

beforeEach(() => {
  watch.mockReset(); ai.mockReset(); refine.mockClear(); describeShots.mockReset(); checkShort.mockReset()
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
    expect(b.warnings.join(' ')).toMatch(/cuts not measured/)
    expect(b.warnings.join(' ')).not.toMatch(/ai-service|502/)
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
  it('refines moment times, excluding hard cuts and covered spans', async () => {
    watch.mockResolvedValue(overview(['hidden_changes']))
    ai.mockImplementation(async (route: string) => {
      if (route === '/media/cuts') return { cuts: [7.0], fades: [], duration_s: 14.9 }
      if (route === '/media/hidden-cuts') return { hidden_cuts: [{ from: 'l0', to: 'l1', at_s: 5.43, covered_s: [4.5, 6.1] }], cover_threshold: 0.6 }
      return { curve_db: [], events: [], rhythm: [], silent_from_s: null, bpm: null, beats_s: [], has_audio: true }
    })
    await breakDownVideo({ url: 'https://www.instagram.com/p/x/' }, ctx)
    expect(refine.mock.calls[0][2]).toEqual([[6.9, 7.1], [4.5, 6.1]])
  })
  it('breaks down a local file without fetching or uploading (golden set)', async () => {
    watch.mockResolvedValue(overview(['hard_cuts']))
    ai.mockImplementation(async (route: string) => route === '/media/cuts' ? { cuts: [2, 5], fades: [], duration_s: 14.9 } : { curve_db: [], events: [], rhythm: [], silent_from_s: null, bpm: null, beats_s: [], has_audio: true })
    vi.mocked(fetchVideo).mockClear()
    const b = await breakDownLocalFile('/golden/fan_reel.mp4')
    expect(fetchVideo).not.toHaveBeenCalled()
    expect(b.video).toMatchObject({ durationS: 14.9, platform: 'local', youtubeUrl: null })
    expect(ai.mock.calls[0][1]).toMatchObject({ path: '/golden/fan_reel.mp4' })
  })
  it('does not refine when cuts were not measured — everything stays unmeasured (review I1)', async () => {
    watch.mockResolvedValue({ ...overview(['hard_cuts']), moments: [{ t_s: 2, what: 'x', why_it_matters: '' }] })
    ai.mockImplementation(async (route: string) => { if (route === '/media/cuts') throw new Error('ai-service 502'); return { curve_db: [], events: [], rhythm: [], silent_from_s: null, bpm: null, beats_s: [], has_audio: true } })
    const b = await breakDownVideo({ url: 'https://x.com/a/status/1' }, ctx)
    expect(refine).not.toHaveBeenCalled()
    expect(b.overview.moments[0]).toMatchObject({ t_s: 2, measured: false })
  })
  it('does not refine a hidden-changes video when hidden cuts failed (review I1)', async () => {
    watch.mockResolvedValue(overview(['hidden_changes']))
    ai.mockImplementation(async (route: string) => {
      if (route === '/media/cuts') return { cuts: [], fades: [], duration_s: 14.9 }
      if (route === '/media/hidden-cuts') throw new Error('ai-service 502')
      return { curve_db: [], events: [], rhythm: [], silent_from_s: null, bpm: null, beats_s: [], has_audio: true }
    })
    await breakDownVideo({ url: 'https://www.instagram.com/p/x/' }, ctx)
    expect(refine).not.toHaveBeenCalled()
  })
  it('excludes fades from refinement (review I1)', async () => {
    watch.mockResolvedValue(overview(['hard_cuts']))
    ai.mockImplementation(async (route: string) => route === '/media/cuts' ? { cuts: [], fades: [[10, 11.5]], duration_s: 14.9 } : { curve_db: [], events: [], rhythm: [], silent_from_s: null, bpm: null, beats_s: [], has_audio: true })
    await breakDownVideo({ url: 'https://x.com/a/status/1' }, ctx)
    expect(refine.mock.calls[0][2]).toEqual([[10, 11.5]])
  })
  it('remembers the latest breakdown per scope and link for reuse (review I3)', async () => {
    watch.mockResolvedValue(overview(['hard_cuts']))
    ai.mockImplementation(async (route: string) => route === '/media/cuts' ? { cuts: [], fades: [], duration_s: 14.9 } : { curve_db: [], events: [], rhythm: [], silent_from_s: null, bpm: null, beats_s: [], has_audio: true })
    const b = await breakDownVideo({ url: 'https://x.com/a/status/9' }, ctx)
    expect(recentBreakdown({ url: 'https://x.com/a/status/9' }, ctx)).toBe(b)
    expect(recentBreakdown({ url: 'https://x.com/a/status/9' }, { ...ctx, scopeId: 'other-tenant' })).toBeUndefined()
  })
  it('measures leg side per look and replaces Gemini\'s reading with it', async () => {
    watch.mockResolvedValue({ ...overview(['hidden_changes'], 2), subject_box: [0.1, 0.05, 0.9, 0.95], looks: [{ label: 'l0', approx_start_s: 0, approx_end_s: 5, leg_side: 'center' }, { label: 'l1', approx_start_s: 6, approx_end_s: 14, leg_side: 'center' }] })
    ai.mockImplementation(async (route: string) => {
      if (route === '/media/cuts') return { cuts: [], fades: [], duration_s: 14.9 }
      if (route === '/media/hidden-cuts') return { hidden_cuts: [{ from: 'l0', to: 'l1', at_s: 5.4, covered_s: [4.6, 6.2] }], cover_threshold: 0.6 }
      if (route === '/media/pose') return { model: 'yolox-tiny + rtmpose-s', camera_moves: [], moves: [{ t_s: 3.2, from_s: 3, to_s: 3.6, area: 'lower', direction: 'image-right', strength: 0.2 }], looks: [
        { label: 'l0', start_s: 0, end_s: 5.4, frames_used: 30, people: 1, people_max: 1, no_person: false, main_start: { framing: 'full_body', orientation: 'vertical' }, main_end: { framing: 'full_body', orientation: 'vertical', knees: 'bent' }, leg_side_start: 'center', leg_side_end: 'image-right', body_angle_end: 4.1, key_frames: [] },
        { label: 'l1', start_s: 5.4, end_s: 14.9, frames_used: 1, people: 0, people_max: 0, no_person: true, main_start: null, main_end: null, leg_side_start: 'unknown', leg_side_end: 'unknown', body_angle_end: null, key_frames: [] },
      ] }
      return { curve_db: [], events: [], rhythm: [], silent_from_s: null, bpm: null, beats_s: [], has_audio: true }
    })
    const b = await breakDownVideo({ url: 'https://www.instagram.com/p/x/' }, ctx)
    const poseCall = ai.mock.calls.find((c) => c[0] === '/media/pose')!
    expect(poseCall[1]).toEqual({ path: '/m/a.mp4', looks: [{ label: 'l0', start_s: 0, end_s: 5.4 }, { label: 'l1', start_s: 5.4, end_s: 14.9 }], exclude: [[4.6, 6.2]] })
    expect(b.overview.looks[0]).toMatchObject({ leg_side: 'image-right', leg_side_start: 'center', leg_side_source: 'measured', body_angle: 4.1 })
    expect(b.overview.looks[0].body).toMatchObject({ people: 1, no_person: false, end: { knees: 'bent' } })
    expect(b.overview.looks[0].measured).toMatch(/^Measured: 1 person, full body, upright in frame, knees bent.*legs right at 3\.2s/)
    expect(b.overview.looks[1].measured).toBe('Measured: no person in shot')
    expect(b.overview.looks[1]).toMatchObject({ leg_side: 'center', leg_side_source: 'gemini', body: { people: 0, no_person: true } })
    expect(b.pose?.moves[0]).toMatchObject({ direction: 'image-right' })
  })
  it('keeps Gemini\'s leg sides, marked as such, when pose cannot be measured', async () => {
    watch.mockResolvedValue({ ...overview(['hard_cuts'], 1), looks: [{ label: 'l0', approx_start_s: 0, approx_end_s: 14, leg_side: 'image-left' }] })
    ai.mockImplementation(async (route: string) => {
      if (route === '/media/cuts') return { cuts: [], fades: [], duration_s: 14.9 }
      if (route === '/media/pose') throw new Error('ai-service 502')
      return { curve_db: [], events: [], rhythm: [], silent_from_s: null, bpm: null, beats_s: [], has_audio: true }
    })
    const b = await breakDownVideo({ url: 'https://x.com/a/status/1' }, ctx)
    expect(b.overview.looks[0]).toMatchObject({ leg_side: 'image-left', leg_side_source: 'gemini' })
    expect(b.warnings.join(' ')).toMatch(/body readings unavailable/)
  })
})

describe('lookSpans', () => {
  it('uses the hidden cuts and their labels when there are any', () => {
    const o = { looks: [{ label: 'a', approx_start_s: 0, approx_end_s: 4 }, { label: 'b', approx_start_s: 6, approx_end_s: 9 }] } as any
    expect(lookSpans(o, [{ from: 'a', to: 'b', at_s: 5.4, covered_s: [4.6, 6.2] }], 10)).toEqual([{ label: 'a', start_s: 0, end_s: 5.4 }, { label: 'b', start_s: 5.4, end_s: 10 }])
  })
  it('falls back to the looks\' own rough bounds, dropping empty ones', () => {
    const o = { looks: [{ label: 'a', approx_start_s: 0, approx_end_s: 4 }, { label: 'b', approx_start_s: 9, approx_end_s: 9 }] } as any
    expect(lookSpans(o, [], 10)).toEqual([{ label: 'a', start_s: 0, end_s: 4 }])
  })
  // Live Snitch run: the watch said look 1 ends at 3.7s, the measured cut is 3.43s, so look 1's
  // end guide frame (3.63s) came from look 2's shot.
  it('snaps a rough look edge to a measured cut close by', () => {
    const o = { looks: [{ label: 'a', approx_start_s: 0, approx_end_s: 3.7 }, { label: 'b', approx_start_s: 3.7, approx_end_s: 14.3 }] } as any
    expect(lookSpans(o, [], 15.87, [3.43])).toEqual([{ label: 'a', start_s: 0, end_s: 3.43 }, { label: 'b', start_s: 3.43, end_s: 14.3 }])
  })
  it('leaves an edge alone when no cut is close', () => {
    const o = { looks: [{ label: 'a', approx_start_s: 0, approx_end_s: 3.7 }] } as any
    expect(lookSpans(o, [], 10, [6])).toEqual([{ label: 'a', start_s: 0, end_s: 3.7 }])
  })
})

describe('watch-only fallback (YouTube blocks the server download)', () => {
  it('still gives Gemini\'s reading of the link, clearly unmeasured, and runs no measurement', async () => {
    vi.mocked(fetchVideo).mockRejectedValueOnce(new DownloadBlocked('blocked', 'https://www.youtube.com/watch?v=abc', null, null, null))
    watch.mockResolvedValue({ ...overview(['hard_cuts'], 1), moments: [{ t_s: 2, what: 'x', why_it_matters: '' }], looks: [{ label: 'l0', approx_start_s: 0, approx_end_s: 10, leg_side: 'image-left' }] })
    const b = await breakDownVideo({ url: 'https://www.youtube.com/watch?v=abc' }, ctx)
    expect(watch.mock.calls[0][0]).toMatchObject({ youtubeUrl: 'https://www.youtube.com/watch?v=abc' })
    expect(ai).not.toHaveBeenCalled()
    expect(b).toMatchObject({ watch_only: true, measured: false, cuts: null, sound: null, pose: null, hidden_cuts: [] })
    expect(b.overview.moments[0]).toMatchObject({ measured: false })
    expect(b.overview.looks[0]).toMatchObject({ leg_side_source: 'gemini' })
    expect(b.warnings.join(' ')).toMatch(/upload the video file/)
    expect(recentBreakdown({ url: 'https://www.youtube.com/watch?v=abc' }, ctx)).toBeUndefined()
  })
})

describe('speed', () => {
  it('measures pose while Gemini describes the shots, not before or after', async () => {
    watch.mockResolvedValue(overview(['hard_cuts'], 2))
    let describing = false
    let overlapped = false
    ai.mockImplementation(async (route: string) => {
      if (route === '/media/cuts') return { cuts: [7], fades: [], duration_s: 14.9 }
      if (route === '/media/pose') {
        for (let i = 0; i < 20 && !describing; i++) await new Promise((r) => setTimeout(r, 2))
        overlapped = describing
        return { model: 'rtmpose-s', looks: [], moves: [] }
      }
      return { curve_db: [], events: [], rhythm: [], silent_from_s: null, bpm: null, beats_s: [], has_audio: true }
    })
    describeShots.mockImplementation(async () => { describing = true; await new Promise((r) => setTimeout(r, 20)); describing = false; return { shots: [], sound_arc: '' } })
    await breakDownVideo({ url: 'https://x.com/a/status/1' }, ctx)
    expect(overlapped).toBe(true)
  })
})

describe('wording the user (or Olmo) can see', () => {
  it('never names providers or internal machinery', async () => {
    vi.mocked(fetchVideo).mockRejectedValueOnce(new DownloadBlocked('x', 'https://www.youtube.com/watch?v=abc', null, null, null))
    watch.mockResolvedValue({ ...overview(['hard_cuts'], 1), moments: [{ t_s: 2, what: 'x', why_it_matters: '' }] })
    const yt = await breakDownVideo({ url: 'https://www.youtube.com/watch?v=abc' }, ctx)
    watch.mockResolvedValue({ ...overview(['hidden_changes'], 2), moments: [{ t_s: 2, what: 'x', why_it_matters: '' }] })
    ai.mockRejectedValue(new Error('ai-service 502'))
    describeShots.mockRejectedValueOnce(new Error('gateway 502'))
    const down = await breakDownVideo({ url: 'https://x.com/a/status/1' }, ctx)
    const text = [...yt.warnings, ...down.warnings].join(' ')
    expect(text).not.toMatch(/gemini|download|server|ai-service|gateway|yt-dlp|502/i)
  })
})

describe('trick log (which tricks real reels use)', () => {
  it('logs one structured line per breakdown with the trick, change style, format and platform', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    watch.mockResolvedValue({ ...overview(['hidden_changes'], 2), trick: 'a fan blade sweeps past the lens', format: 'outfit change', layout: 'full frame' })
    ai.mockImplementation(async (route: string) => route === '/media/cuts' ? { cuts: [], fades: [], duration_s: 14.9 } : route === '/media/hidden-cuts' ? { hidden_cuts: [], cover_threshold: null } : { curve_db: [], events: [], rhythm: [], silent_from_s: null, bpm: null, beats_s: [], has_audio: true })
    await breakDownVideo({ url: 'https://www.instagram.com/p/trick/' }, ctx)
    const line = info.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith('[trick-log] '))
    expect(line).toBeTruthy()
    expect(JSON.parse(line!.slice('[trick-log] '.length))).toMatchObject({ platform: 'instagram', trick: 'a fan blade sweeps past the lens', change_style: ['hidden_changes'], format: 'outfit change', layout: 'full frame', measured: true })
    info.mockRestore()
  })
})
