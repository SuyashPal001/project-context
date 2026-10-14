import { describe, it, expect, vi } from 'vitest'
import { aiService } from './aiServiceClient.js'
import { findCutsTool } from './measureTools.js'

vi.mock('./fetchVideo.js', () => ({ fetchVideo: vi.fn(async () => ({ filePath: '', durationS: 600, tooLong: true })) }))

describe('measure tools on long videos (review M1)', () => {
  it('refuse a video over 90s instead of running CPU work on it', async () => {
    const rc = new Map([['idToken', 't'], ['sessionId', 's']])
    const r = await (findCutsTool as unknown as { execute: (i: unknown, c: unknown) => Promise<{ success: boolean; error?: string }> }).execute({ url: 'https://x.com/a/status/1' }, { requestContext: { get: (k: string) => rc.get(k) } })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/which part/)
  })
})

describe('aiService', () => {
  it('posts JSON with the internal key to AI_SERVICE_URL', async () => {
    process.env.AI_SERVICE_URL = 'http://ai:3004'
    process.env.INTERNAL_SERVICE_KEY = 'k'
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ cuts: [1.2], fades: [], duration_s: 5 })))
    const r = await aiService<{ cuts: number[] }>('/media/cuts', { path: '/m/a.mp4' }, fetchImpl)
    expect(r.cuts).toEqual([1.2])
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://ai:3004/media/cuts')
    expect((init.headers as Record<string, string>)['x-internal-service-key']).toBe('k')
  })
  it('throws with the status on failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 400 }))
    await expect(aiService('/media/sound', { path: '/x' }, fetchImpl)).rejects.toThrow('ai-service 400')
  })
})
