import { describe, it, expect, vi } from 'vitest'
import { WATCH_PROMPT, normalizeOverview, watchVideo } from './watchVideo.js'

vi.mock('../../cost.js', () => ({ persistCost: vi.fn() }))

describe('WATCH_PROMPT', () => {
  it('asks for every field the remake needs', () => {
    for (const key of ['change_style', 'looks', 'start_pose', 'end_pose', 'moves', 'leg_side', 'subject_box', 'story', 'moments', 'setting', 'props', 'expression', 'never_copy', 'music', 'has_vocals', 'never guess']) {
      expect(WATCH_PROMPT).toContain(key)
    }
    expect(WATCH_PROMPT).toMatch(/image-left|image-right/)
  })
})

describe('normalizeOverview', () => {
  it('drops unknown change styles and clamps the subject box', () => {
    const o = normalizeOverview({ change_style: ['hard_cuts', 'teleport'], subject_box: [-0.2, 0.1, 1.4, 0.9] })
    expect(o.change_style).toEqual(['hard_cuts'])
    expect(o.subject_box).toEqual([0, 0.1, 1, 0.9])
    expect(o.looks).toEqual([])
    expect(o.never_copy).toEqual([])
    expect(o.music).toEqual({ mood: '', genre: '', instruments: '', has_vocals: null, song_name: null })
  })
})

describe('watchVideo', () => {
  it('returns a normalized overview from a bare-list reply', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '[{"format":"fan wipe","change_style":["hidden_changes"],"looks":[{"label":"a","approx_start_s":0,"approx_end_s":5}]}]' } }], usage: {} })))
    const o = await watchVideo({ filePath: undefined as unknown as string, youtubeUrl: 'https://youtu.be/x', durationS: 15 }, undefined, fetchImpl)
    expect(o.format).toBe('fan wipe')
    expect(o.change_style).toEqual(['hidden_changes'])
    expect(o.looks).toHaveLength(1)
  })
})

describe('watchVideo never returns a silently empty overview (review I2)', () => {
  const reply = (content: string) => vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: {} })))
  const yt = { filePath: undefined as unknown as string, youtubeUrl: 'https://youtu.be/x', durationS: 15 }
  it('unwraps an overview nested under one key', async () => {
    const o = await watchVideo(yt, undefined, reply('{"overview":{"format":"fan wipe","change_style":["hidden_changes"],"looks":[{"label":"a","approx_start_s":0,"approx_end_s":5}]}}'))
    expect(o.format).toBe('fan wipe')
    expect(o.looks).toHaveLength(1)
  })
  it('throws on an empty object', async () => {
    await expect(watchVideo(yt, undefined, reply('{}'))).rejects.toThrow('unreadable model reply')
  })
  it('throws when the reply is a single look instead of an overview', async () => {
    await expect(watchVideo(yt, undefined, reply('[{"label":"jacket","approx_start_s":0,"approx_end_s":14,"moves":[{"t_s":1,"limb":"arm","direction":"up","how":"raise"}]}]'))).rejects.toThrow('unreadable model reply')
  })
})
