import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.stubEnv('FAL_API_KEY', 'test-fal-key')
vi.stubEnv('SYNC_LABS_API_KEY', 'test-sync-key')

import { generateLipsync, UnsupportedLipsyncModelError, LipsyncTimeoutError } from './lipsync.js'

describe('generateLipsync', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('rejects a model not on the allowlist', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateLipsync({ model: 'not-real', videoUri: 'https://x/v.mp4', audioUri: 'https://x/a.wav' }))
      .rejects.toThrow(UnsupportedLipsyncModelError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('submits to fal.ai, polls until complete, fetches the result off response_url, and returns the result video', async () => {
    // fal.ai's queue API: the /status response never carries the model
    // output — only {status, response_url}. The result (video.url) lives at
    // a SEPARATE fetch to response_url once status is COMPLETED.
    const fetchMock = vi.fn()
      // 1. submit job
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'job-1' }), { status: 200 }))
      // 2. first poll: still processing
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'IN_PROGRESS' }), { status: 200 }))
      // 3. second poll: complete, but only a response_url — no video field
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED', response_url: 'https://fal.example/requests/job-1' }), { status: 200 }))
      // 4. result fetch: the actual output lives here
      .mockResolvedValueOnce(new Response(JSON.stringify({ video: { url: 'https://fal.example/out.mp4' } }), { status: 200 }))
      // 5. download the result video bytes
      .mockResolvedValueOnce(new Response(Buffer.from('fake-mp4-bytes'), { status: 200, headers: { 'Content-Type': 'video/mp4' } }))
    vi.stubGlobal('fetch', fetchMock)

    const promise = generateLipsync({ model: 'fal-ai/latentsync', videoUri: 'https://x/v.mp4', audioUri: 'https://x/a.wav' })
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await promise

    expect(result).toMatchObject({ mimeType: 'video/mp4' })
    expect('videoBase64' in result && typeof result.videoBase64 === 'string').toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(5)

    // 1. submit
    const [submitUrl, submitOpts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(submitUrl).toBe('https://queue.fal.run/fal-ai/latentsync')
    expect(submitOpts.method).toBe('POST')
    expect(submitOpts.headers).toMatchObject({ Authorization: 'Key test-fal-key' })
    expect(JSON.parse(submitOpts.body as string)).toMatchObject({ video_url: 'https://x/v.mp4', audio_url: 'https://x/a.wav' })

    // 2. first poll (status endpoint)
    const [pollUrl1] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(pollUrl1).toBe('https://queue.fal.run/fal-ai/latentsync/requests/job-1/status')

    // 3. second poll (status endpoint again)
    const [pollUrl2] = fetchMock.mock.calls[2] as unknown as [string, RequestInit]
    expect(pollUrl2).toBe('https://queue.fal.run/fal-ai/latentsync/requests/job-1/status')

    // 4. result fetch — MUST be response_url, a different endpoint from status
    const [resultUrl, resultOpts] = fetchMock.mock.calls[3] as unknown as [string, RequestInit]
    expect(resultUrl).toBe('https://fal.example/requests/job-1')
    expect(resultOpts.headers).toMatchObject({ Authorization: 'Key test-fal-key' })

    // 5. download
    const [downloadUrl] = fetchMock.mock.calls[4] as unknown as [string, RequestInit]
    expect(downloadUrl).toBe('https://fal.example/out.mp4')
  })

  it('falls back to the constructed result URL when response_url is absent', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'job-2' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ video: { url: 'https://fal.example/out2.mp4' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(Buffer.from('bytes'), { status: 200, headers: { 'Content-Type': 'video/mp4' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateLipsync({ model: 'fal-ai/latentsync', videoUri: 'https://x/v.mp4', audioUri: 'https://x/a.wav' })

    expect(result).toMatchObject({ mimeType: 'video/mp4' })
    const [resultUrl] = fetchMock.mock.calls[2] as unknown as [string, RequestInit]
    expect(resultUrl).toBe('https://queue.fal.run/fal-ai/latentsync/requests/job-2')
  })

  it('submits to Sync Labs v2, polls until complete, and returns the result video', async () => {
    const fetchMock = vi.fn()
      // 1. submit job
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'sync-job-1' }), { status: 200 }))
      // 2. first poll: still processing
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'PROCESSING' }), { status: 200 }))
      // 3. second poll: complete, with outputUrl
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED', outputUrl: 'https://sync.example/out.mp4' }), { status: 200 }))
      // 4. download the result video bytes
      .mockResolvedValueOnce(new Response(Buffer.from('fake-mp4-bytes'), { status: 200, headers: { 'Content-Type': 'video/mp4' } }))
    vi.stubGlobal('fetch', fetchMock)

    const promise = generateLipsync({ model: 'sync-2.0', videoUri: 'https://x/v.mp4', audioUri: 'https://x/a.wav' })
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await promise

    expect(result).toMatchObject({ mimeType: 'video/mp4' })
    expect('videoBase64' in result && typeof result.videoBase64 === 'string').toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(4)

    // 1. submit — v2 endpoint, input array shape, not the legacy flat fields
    const [submitUrl, submitOpts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(submitUrl).toBe('https://api.sync.so/v2/generate')
    expect(submitOpts.method).toBe('POST')
    expect(submitOpts.headers).toMatchObject({ 'x-api-key': 'test-sync-key' })
    const submitBody = JSON.parse(submitOpts.body as string)
    expect(submitBody).toMatchObject({
      model: 'lipsync-2',
      input: [
        { type: 'video', url: 'https://x/v.mp4' },
        { type: 'audio', url: 'https://x/a.wav' },
      ],
    })

    // 2 & 3. poll
    const [pollUrl] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(pollUrl).toBe('https://api.sync.so/v2/generate/sync-job-1')

    // 4. download
    const [downloadUrl] = fetchMock.mock.calls[3] as unknown as [string, RequestInit]
    expect(downloadUrl).toBe('https://sync.example/out.mp4')
  })

  it('maps a 4xx submit failure to a refused result (fal.ai)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Invalid video URL', { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateLipsync({ model: 'fal-ai/latentsync', videoUri: 'bad', audioUri: 'https://x/a.wav' })
    expect(result).toMatchObject({ refused: true })
    expect(typeof result === 'object' && 'reason' in result && result.reason).toContain('fal.ai rejected')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws (not refused) on a 429 submit failure (fal.ai)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Too many requests', { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateLipsync({ model: 'fal-ai/latentsync', videoUri: 'https://x/v.mp4', audioUri: 'https://x/a.wav' }))
      .rejects.toThrow(/fal.ai lipsync submit failed/)
  })

  it('rejects an oversized result download', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'job-3' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED', response_url: 'https://fal.example/requests/job-3' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ video: { url: 'https://fal.example/huge.mp4' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(Buffer.alloc(0), {
        status: 200,
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(101 * 1024 * 1024) },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateLipsync({ model: 'fal-ai/latentsync', videoUri: 'https://x/v.mp4', audioUri: 'https://x/a.wav' })
    expect(result).toMatchObject({ refused: true, reason: 'Video size exceeds limit' })
  })

  it('rejects a result download with an unexpected content-type', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'job-4' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'COMPLETED', response_url: 'https://fal.example/requests/job-4' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ video: { url: 'https://fal.example/notavideo' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response('<html>error</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateLipsync({ model: 'fal-ai/latentsync', videoUri: 'https://x/v.mp4', audioUri: 'https://x/a.wav' })
    expect(result).toMatchObject({ refused: true, reason: /Unexpected content-type/ })
  })

  it('throws LipsyncTimeoutError if the job never completes within the budget', async () => {
    // Each call must return a fresh Response instance — Response.json() can
    // only be read once per instance (a single shared object via
    // mockResolvedValue throws "Body is unusable" on the second poll).
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ request_id: 'job-1' }), { status: 200 }))
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ status: 'IN_PROGRESS' }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    const promise = generateLipsync({ model: 'fal-ai/latentsync', videoUri: 'https://x/v.mp4', audioUri: 'https://x/a.wav' })
    const assertion = expect(promise).rejects.toThrow(LipsyncTimeoutError)
    await vi.advanceTimersByTimeAsync(300_000)
    await assertion
  })
})
