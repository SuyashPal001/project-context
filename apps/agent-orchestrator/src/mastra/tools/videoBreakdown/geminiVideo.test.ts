import { describe, it, expect, vi } from 'vitest'
import { fpsForDuration, parseModelJson, asObject, askGeminiVideo } from './geminiVideo.js'

vi.mock('../../cost.js', () => ({ persistCost: vi.fn() }))

describe('fpsForDuration', () => {
  it('uses 4 / 2 / 1 fps by length', () => {
    expect(fpsForDuration(15)).toBe(4)
    expect(fpsForDuration(30)).toBe(4)
    expect(fpsForDuration(60)).toBe(2)
    expect(fpsForDuration(178)).toBe(1)
  })
})

describe('parseModelJson / asObject', () => {
  it('parses fenced JSON objects', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
  it('parses a bare list and wraps it under the list key', () => {
    expect(asObject(parseModelJson('[{"t":0,"remotes":1}]'), 'frames')).toEqual({ frames: [{ t: 0, remotes: 1 }] })
  })
  it('unwraps a one-item list holding the real object', () => {
    expect(asObject(parseModelJson('[{"shots":[]}]'), 'shots')).toEqual({ shots: [] })
  })
  it('throws on prose with no JSON', () => {
    expect(() => parseModelJson('Sorry, I cannot help')).toThrow('unreadable model reply')
  })
})

describe('askGeminiVideo', () => {
  it('sends a YouTube URL as input_video.url with the length-based fps and LOW thinking', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })))
    const out = await askGeminiVideo({ video: { youtubeUrl: 'https://www.youtube.com/watch?v=x' }, durationS: 60, prompt: 'p', agentId: 'watch-video', fetchImpl })
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.model).toBe('gemini-3.8-flash')
    expect(body.thinkingLevel).toBe('LOW')
    expect(body.messages[0].content[0]).toEqual({ type: 'input_video', input_video: { url: 'https://www.youtube.com/watch?v=x', fps: 2 } })
    expect(out.raw).toBe('{"ok":true}')
  })
  it('throws on a non-200 gateway reply', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 502 }))
    await expect(askGeminiVideo({ video: { youtubeUrl: 'u' }, durationS: 10, prompt: 'p', agentId: 'a', fetchImpl })).rejects.toThrow('gateway 502')
  })
})

describe('prepareAnalysisCopy (review I5, I6)', () => {
  it('writes the analysis copy atomically and keeps only the frames Gemini samples', async () => {
    vi.resetModules()
    const calls: string[][] = []
    vi.doMock('node:child_process', () => ({ execFile: (_f: string, a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => { calls.push(a); cb(null, { stdout: '', stderr: '' }) } }))
    const fsState = new Set<string>()
    vi.doMock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), existsSync: (p: string) => fsState.has(p), renameSync: (_a: string, b: string) => { fsState.add(b) }, unlinkSync: () => {}, statSync: () => ({ size: 1000 }) }))
    const { prepareAnalysisCopy } = await import('./geminiVideo.js')
    const out = await prepareAnalysisCopy('/m/a.mp4', 200)
    expect(out).toBe('/m/a.mp4.analysis.mp4')
    const args = calls[0]
    expect(args[args.length - 1]).toMatch(/\.tmp-/)
    expect(args).toEqual(expect.arrayContaining(['-r', '1', '-ac', '1']))
    vi.doUnmock('node:child_process'); vi.doUnmock('node:fs')
  })
})

it('an unknown duration watches at the cheapest rate (watch-only YouTube fallback)', async () => {
  const { fpsForDuration } = await import('./geminiVideo.js')
  expect(fpsForDuration(NaN)).toBe(1)
})
