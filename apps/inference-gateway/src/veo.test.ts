import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./router.js', () => ({
  geminiVideoBreaker: { isAvailable: vi.fn(() => true), onSuccess: vi.fn(), onFailure: vi.fn() },
  vertexVideoBreaker: { isAvailable: vi.fn(() => true), onSuccess: vi.fn(), onFailure: vi.fn() },
}))
vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(function GoogleAuth() {
    return { getClient: vi.fn().mockResolvedValue({ getAccessToken: vi.fn().mockResolvedValue({ token: 'fake-token' }) }) }
  }),
}))

import { veoTransitionBody, VEO_31_MODEL } from './veo'
import { generateVideo } from './video'

const img = (s: string) => new Response(Buffer.from(s), { headers: { 'content-type': 'image/jpeg' } })

describe('veoTransitionBody', () => {
  it('matches the body proven in the spike: inline start and last frame, no audio, 720p', () => {
    const b = veoTransitionBody({ prompt: 'P', start: { data: 'AAA', mime: 'image/jpeg' }, last: { data: 'BBB', mime: 'image/png' }, seconds: 6, aspectRatio: '9:16' })
    expect(b).toEqual({
      instances: [{ prompt: 'P', image: { bytesBase64Encoded: 'AAA', mimeType: 'image/jpeg' }, lastFrame: { bytesBase64Encoded: 'BBB', mimeType: 'image/png' } }],
      parameters: { aspectRatio: '9:16', durationSeconds: 6, sampleCount: 1, generateAudio: false, resolution: '720p', personGeneration: 'allow_adult' },
    })
  })
  it('a start-only clip has no lastFrame', () => {
    const b = veoTransitionBody({ prompt: 'P', start: { data: 'A', mime: 'image/jpeg' }, last: null, seconds: 4, aspectRatio: '16:9' })
    expect(b.instances[0]).not.toHaveProperty('lastFrame')
  })
})

describe('generateVideo with veo-3.1-fast-generate-001', () => {
  beforeEach(() => { process.env.VERTEX_PROJECT = 'p'; vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('fetches both stills, starts the operation, polls fetchPredictOperation, returns the video', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url)
      if (url === 'https://s3/start.jpg') return img('start')
      if (url === 'https://s3/end.jpg') return img('end')
      if (url.endsWith(':predictLongRunning')) {
        const body = JSON.parse(String(init!.body))
        expect(body.instances[0].image.bytesBase64Encoded).toBe(Buffer.from('start').toString('base64'))
        expect(body.instances[0].lastFrame.bytesBase64Encoded).toBe(Buffer.from('end').toString('base64'))
        return Response.json({ name: 'projects/p/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001/operations/op1' })
      }
      if (url.endsWith(':fetchPredictOperation')) return Response.json({ done: true, response: { videos: [{ bytesBase64Encoded: 'VID', mimeType: 'video/mp4' }] } })
      throw new Error(`unexpected ${url}`)
    }))
    const r = await generateVideo({ model: VEO_31_MODEL, prompt: 'P', task: 'image_to_video', aspectRatio: '9:16', durationSeconds: 6, imageUri: 'https://s3/start.jpg', lastFrameUri: 'https://s3/end.jpg' })
    expect(r).toEqual({ videoBase64: 'VID', mimeType: 'video/mp4' })
    expect(calls.some((u) => u.includes('us-central1-aiplatform.googleapis.com') && u.includes('veo-3.1-fast-generate-001:predictLongRunning'))).toBe(true)
  })

  it('a done operation with no video (filtered) is a content block, not an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('https://s3/')) return img('x')
      if (url.endsWith(':predictLongRunning')) return Response.json({ name: 'op' })
      return Response.json({ done: true, response: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ['person'] } })
    }))
    const r = await generateVideo({ model: VEO_31_MODEL, prompt: 'P', task: 'image_to_video', aspectRatio: '9:16', durationSeconds: 4, imageUri: 'https://s3/a.jpg' })
    expect(r).toEqual({ refused: true, reason: 'CONTENT_BLOCKED' })
  })

  it('rejects durations Veo 3.1 does not take and a missing start image', async () => {
    await expect(generateVideo({ model: VEO_31_MODEL, prompt: 'P', task: 'image_to_video', aspectRatio: '9:16', durationSeconds: 5, imageUri: 'https://s3/a.jpg' })).rejects.toThrow(/4, 6 or 8/)
    await expect(generateVideo({ model: VEO_31_MODEL, prompt: 'P', task: 'image_to_video', aspectRatio: '9:16', durationSeconds: 4 })).rejects.toThrow(/start image/)
  })

  it('an operation error surfaces as a backend error, never a video', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('https://s3/')) return img('x')
      if (url.endsWith(':predictLongRunning')) return Response.json({ name: 'op' })
      return Response.json({ done: true, error: { message: 'quota' } })
    }))
    await expect(generateVideo({ model: VEO_31_MODEL, prompt: 'P', task: 'image_to_video', aspectRatio: '9:16', durationSeconds: 4, imageUri: 'https://s3/a.jpg' })).rejects.toThrow(/quota/)
  })
})

describe('I6 Veo polling', () => {
  beforeEach(() => { process.env.VERTEX_PROJECT = 'p'; vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
  it('a transient poll error does not throw away a generation Google is still making', async () => {
    let polls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('https://s3/')) return new Response(Buffer.from('x'), { headers: { 'content-type': 'image/jpeg' } })
      if (url.endsWith(':predictLongRunning')) return Response.json({ name: 'op' })
      if (++polls === 1) return new Response('busy', { status: 503 })
      return Response.json({ done: true, response: { videos: [{ bytesBase64Encoded: 'VID', mimeType: 'video/mp4' }] } })
    }))
    const pending = generateVideo({ model: VEO_31_MODEL, prompt: 'P', task: 'image_to_video', aspectRatio: '9:16', durationSeconds: 4, imageUri: 'https://s3/a.jpg' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toEqual({ videoBase64: 'VID', mimeType: 'video/mp4' })
    expect(polls).toBe(2)
  })
  it('the whole call is budgeted under the orchestrator timeout (270s), counted from the request start', async () => {
    const { VEO_TOTAL_BUDGET_MS } = await import('./veo')
    expect(VEO_TOTAL_BUDGET_MS).toBeLessThanOrEqual(230_000)
  })
})
