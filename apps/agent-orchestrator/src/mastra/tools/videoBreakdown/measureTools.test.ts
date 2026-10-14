import { describe, it, expect, vi } from 'vitest'
import { aiService } from './aiServiceClient.js'

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
