import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('FAL_API_KEY', 'test-fal-key')
vi.stubEnv('SYNC_LABS_API_KEY', 'test-sync-key')

import { generateLipsync, UnsupportedLipsyncModelError, LipsyncTimeoutError } from './lipsync.js'

describe('generateLipsync', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
  })

  it('rejects a model not on the allowlist', async () => {
    await expect(generateLipsync({ model: 'not-real', videoUri: 'https://x/v.mp4', audioUri: 'https://x/a.wav' }))
      .rejects.toThrow(UnsupportedLipsyncModelError)
  })

  it('submits to fal.ai, polls until complete, and returns the result video', async () => {
    const fetchMock = vi.fn()
      // 1. submit job
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'job-1' }), { status: 200 }))
      // 2. first poll: still processing
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'IN_PROGRESS' }), { status: 200 }))
      // 3. second poll: complete, with a result video URL
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED', video: { url: 'https://fal.example/out.mp4' } }), { status: 200 }))
      // 4. download the result video bytes
      .mockResolvedValueOnce(new Response(Buffer.from('fake-mp4-bytes'), { status: 200, headers: { 'Content-Type': 'video/mp4' } }))
    global.fetch = fetchMock as unknown as typeof fetch

    const promise = generateLipsync({ model: 'fal-ai/latentsync', videoUri: 'https://x/v.mp4', audioUri: 'https://x/a.wav' })
    // Advance past the poll interval once so the second (IN_PROGRESS) poll and
    // the third (COMPLETED) poll both get their turn on the fake timer queue.
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await promise

    expect(result).toMatchObject({ mimeType: 'video/mp4' })
    expect('videoBase64' in result && typeof result.videoBase64 === 'string').toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('throws LipsyncTimeoutError if the job never completes within the budget', async () => {
    // Each call must return a fresh Response instance — Response.json() can
    // only be read once per instance (a single shared object via
    // mockResolvedValue throws "Body is unusable" on the second poll).
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'job-1' }), { status: 200 }))
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ status: 'IN_PROGRESS' }), { status: 200 })))
    global.fetch = fetchMock as unknown as typeof fetch

    const promise = generateLipsync({ model: 'fal-ai/latentsync', videoUri: 'https://x/v.mp4', audioUri: 'https://x/a.wav' })
    const assertion = expect(promise).rejects.toThrow(LipsyncTimeoutError)
    await vi.advanceTimersByTimeAsync(300_000)
    await assertion
  })
})
