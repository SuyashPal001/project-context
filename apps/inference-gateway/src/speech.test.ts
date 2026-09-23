import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.stubEnv('CARTESIA_API_KEY', 'test-key')

import { generateSpeech, UnsupportedSpeechModelError, readWavDurationSeconds } from './speech.js'

describe('readWavDurationSeconds', () => {
  it('rejects a buffer shorter than 44 bytes', () => {
    const buf = Buffer.alloc(40)
    expect(() => readWavDurationSeconds(buf)).toThrow(/Not a valid WAV file/)
  })

  it('rejects a buffer that does not start with RIFF', () => {
    const buf = Buffer.alloc(44)
    buf.write('XXXX', 0)
    expect(() => readWavDurationSeconds(buf)).toThrow(/Not a valid WAV file/)
  })

  it('rejects a buffer that does not contain WAVE at offset 8', () => {
    const buf = Buffer.alloc(44)
    buf.write('RIFF', 0)
    buf.write('XXXX', 8)
    expect(() => readWavDurationSeconds(buf)).toThrow(/Not a valid WAV file/)
  })

  it('rejects a WAV with unexpected chunk at offset 12 (not fmt)', () => {
    const buf = Buffer.alloc(44)
    buf.write('RIFF', 0)
    buf.write('WAVE', 8)
    buf.write('LIST', 12) // Wrong chunk ID
    expect(() => readWavDurationSeconds(buf)).toThrow(/Unexpected WAV chunk layout/)
  })

  it('rejects a WAV with unexpected chunk at offset 36 (not data)', () => {
    const sampleRate = 44100
    const numSamples = sampleRate * 2
    const dataSize = numSamples * 2
    const buf = Buffer.alloc(44 + dataSize)
    buf.write('RIFF', 0)
    buf.writeUInt32LE(36 + dataSize, 4)
    buf.write('WAVE', 8)
    buf.write('fmt ', 12)
    buf.writeUInt32LE(16, 16)
    buf.writeUInt16LE(1, 20)
    buf.writeUInt16LE(1, 22)
    buf.writeUInt32LE(sampleRate, 24)
    buf.writeUInt32LE(sampleRate * 2, 28)
    buf.writeUInt16LE(2, 32)
    buf.writeUInt16LE(16, 34)
    buf.write('fact', 36) // Wrong chunk ID
    expect(() => readWavDurationSeconds(buf)).toThrow(/Unexpected WAV chunk layout/)
  })

  it('rejects a WAV where dataSize exceeds buffer bounds', () => {
    const buf = Buffer.alloc(44)
    buf.write('RIFF', 0)
    buf.writeUInt32LE(36 + 1000, 4) // Claim huge data size
    buf.write('WAVE', 8)
    buf.write('fmt ', 12)
    buf.writeUInt32LE(16, 16)
    buf.writeUInt16LE(1, 20)
    buf.writeUInt16LE(1, 22)
    buf.writeUInt32LE(44100, 24)
    buf.writeUInt32LE(88200, 28)
    buf.writeUInt16LE(2, 32)
    buf.writeUInt16LE(16, 34)
    buf.write('data', 36)
    buf.writeUInt32LE(1000, 40) // Claims huge data
    expect(() => readWavDurationSeconds(buf)).toThrow(/WAV data chunk size exceeds buffer/)
  })

  it('calculates duration correctly for mono audio', () => {
    const sampleRate = 44100
    const numSamples = sampleRate * 3 // 3 seconds
    const dataSize = numSamples * 2 // 16-bit PCM
    const buf = Buffer.alloc(44 + dataSize)
    buf.write('RIFF', 0)
    buf.writeUInt32LE(36 + dataSize, 4)
    buf.write('WAVE', 8)
    buf.write('fmt ', 12)
    buf.writeUInt32LE(16, 16)
    buf.writeUInt16LE(1, 20) // PCM format
    buf.writeUInt16LE(1, 22) // 1 channel (mono)
    buf.writeUInt32LE(sampleRate, 24)
    buf.writeUInt32LE(sampleRate * 2, 28) // byte rate = sample_rate * channels * bytes_per_sample
    buf.writeUInt16LE(2, 32) // block align = channels * bytes_per_sample
    buf.writeUInt16LE(16, 34) // bits per sample
    buf.write('data', 36)
    buf.writeUInt32LE(dataSize, 40)
    expect(readWavDurationSeconds(buf)).toBe(3)
  })

  it('calculates duration correctly for stereo audio', () => {
    const sampleRate = 44100
    const numSamples = sampleRate * 2 // 2 seconds
    const dataSize = numSamples * 2 * 2 // 16-bit PCM, 2 channels
    const buf = Buffer.alloc(44 + dataSize)
    buf.write('RIFF', 0)
    buf.writeUInt32LE(36 + dataSize, 4)
    buf.write('WAVE', 8)
    buf.write('fmt ', 12)
    buf.writeUInt32LE(16, 16)
    buf.writeUInt16LE(1, 20) // PCM format
    buf.writeUInt16LE(2, 22) // 2 channels (stereo)
    buf.writeUInt32LE(sampleRate, 24)
    buf.writeUInt32LE(sampleRate * 4, 28) // byte rate = sample_rate * channels * bytes_per_sample
    buf.writeUInt16LE(4, 32) // block align = channels * bytes_per_sample
    buf.writeUInt16LE(16, 34) // bits per sample
    buf.write('data', 36)
    buf.writeUInt32LE(dataSize, 40)
    expect(readWavDurationSeconds(buf)).toBe(2)
  })
})

describe('generateSpeech', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects a model not on the allowlist without making any call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try { await generateSpeech({ model: 'not-a-real-model', transcript: 'hi', voiceId: 'v1' }) } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(caught).toBeInstanceOf(UnsupportedSpeechModelError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('calls Cartesia with correct URL, headers, and body, returns audio plus duration on success', async () => {
    const sampleRate = 44100
    const numSamples = sampleRate * 2 // 2 seconds
    const dataSize = numSamples * 2
    const header = Buffer.alloc(44)
    header.write('RIFF', 0); header.writeUInt32LE(36 + dataSize, 4); header.write('WAVE', 8)
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
    header.write('data', 36); header.writeUInt32LE(dataSize, 40)
    const wavBytes = Buffer.concat([header, Buffer.alloc(dataSize)])

    const fetchMock = vi.fn(async () => new Response(wavBytes, {
      status: 200,
      headers: { 'Content-Type': 'audio/wav', 'Content-Length': wavBytes.length.toString() },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateSpeech({ model: 'sonic-3.5', transcript: 'Hello world', voiceId: 'voice-123', language: 'en' })

    expect(result).toMatchObject({ mimeType: 'audio/wav', durationSeconds: 2 })
    expect('audioBase64' in result && typeof result.audioBase64 === 'string').toBe(true)

    // Assert fetch was called with correct args
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const callArgs = fetchMock.mock.calls[0]
    expect(callArgs).toBeDefined()
    const [url, fetchOptions] = callArgs as unknown as [string, RequestInit]
    expect(url).toBe('https://api.cartesia.ai/tts/bytes')
    expect(fetchOptions.method).toBe('POST')
    expect(fetchOptions.headers).toMatchObject({
      'Authorization': 'Bearer test-key',
      'Cartesia-Version': '2026-03-01',
      'Content-Type': 'application/json',
    })
    const body = JSON.parse(fetchOptions.body as string)
    expect(body).toMatchObject({
      model_id: 'sonic-3.5',
      transcript: 'Hello world',
      voice: { mode: 'id', id: 'voice-123' },
      language: 'en',
    })
  })

  it('uses default language "en" when not specified', async () => {
    const sampleRate = 44100
    const numSamples = sampleRate * 1
    const dataSize = numSamples * 2
    const header = Buffer.alloc(44)
    header.write('RIFF', 0); header.writeUInt32LE(36 + dataSize, 4); header.write('WAVE', 8)
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
    header.write('data', 36); header.writeUInt32LE(dataSize, 40)
    const wavBytes = Buffer.concat([header, Buffer.alloc(dataSize)])

    const fetchMock = vi.fn(async () => new Response(wavBytes, {
      status: 200,
      headers: { 'Content-Type': 'audio/wav' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await generateSpeech({ model: 'sonic-3.5', transcript: 'test', voiceId: 'v1' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const callArgs = fetchMock.mock.calls[0]
    expect(callArgs).toBeDefined()
    const fetchOptions = (callArgs as unknown as [string, RequestInit])[1]
    const body = JSON.parse(fetchOptions.body as string)
    expect(body.language).toBe('en')
  })

  it('returns refused result for Cartesia 4xx error (bad voiceId)', async () => {
    const fetchMock = vi.fn(async () => new Response('Invalid voice ID', { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateSpeech({ model: 'sonic-3.5', transcript: 'Hello', voiceId: 'invalid-id' })

    expect(result).toMatchObject({ refused: true })
    expect(typeof result === 'object' && 'reason' in result && result.reason).toContain('Cartesia rejected')
  })

  it('returns refused result for unexpected content-type', async () => {
    const fetchMock = vi.fn(async () => new Response('HTML error page', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateSpeech({ model: 'sonic-3.5', transcript: 'Hello', voiceId: 'v1' })

    expect(result).toMatchObject({ refused: true, reason: /Unexpected content-type/ })
  })

  it('returns refused result when audio size exceeds limit (Content-Length)', async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.alloc(0), {
      status: 200,
      headers: { 'Content-Type': 'audio/wav', 'Content-Length': (11 * 1024 * 1024).toString() },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateSpeech({ model: 'sonic-3.5', transcript: 'Hello', voiceId: 'v1' })

    expect(result).toMatchObject({ refused: true, reason: /Audio size exceeds limit/ })
  })

  it('returns refused result when audio size exceeds limit (actual buffer)', async () => {
    const oversized = Buffer.alloc(11 * 1024 * 1024)
    const fetchMock = vi.fn(async () => new Response(oversized, {
      status: 200,
      headers: { 'Content-Type': 'audio/wav' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateSpeech({ model: 'sonic-3.5', transcript: 'Hello', voiceId: 'v1' })

    expect(result).toMatchObject({ refused: true, reason: /Audio size exceeds limit/ })
  })

  it('throws for Cartesia 5xx error (transient failure)', async () => {
    const fetchMock = vi.fn(async () => new Response('Internal server error', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try { await generateSpeech({ model: 'sonic-3.5', transcript: 'Hello', voiceId: 'v1' }) } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/Cartesia speech generation failed/)
  })

  it('throws for rate-limit (429)', async () => {
    const fetchMock = vi.fn(async () => new Response('Too many requests', { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)

    let caught: Error | undefined
    try { await generateSpeech({ model: 'sonic-3.5', transcript: 'Hello', voiceId: 'v1' }) } catch (e) { caught = e as Error }

    expect(caught).toBeDefined()
    expect(caught!.message).toMatch(/Cartesia speech generation failed/)
  })
})
