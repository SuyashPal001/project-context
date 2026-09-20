import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.stubEnv('CARTESIA_API_KEY', 'test-key')

import { generateSpeech, UnsupportedSpeechModelError } from './speech.js'

describe('generateSpeech', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('rejects a model not on the allowlist', async () => {
    await expect(generateSpeech({ model: 'not-a-real-model', transcript: 'hi', voiceId: 'v1' }))
      .rejects.toThrow(UnsupportedSpeechModelError)
  })

  it('calls Cartesia and returns audio plus duration on success', async () => {
    // Cartesia returns raw WAV bytes; duration is read from the WAV header's
    // data-chunk size and sample rate, not from a JSON field (Cartesia's
    // /tts/bytes response is the audio file itself, not JSON).
    const sampleRate = 44100
    const numSamples = sampleRate * 2 // 2 seconds of silence
    const dataSize = numSamples * 2 // 16-bit PCM
    const header = Buffer.alloc(44)
    header.write('RIFF', 0); header.writeUInt32LE(36 + dataSize, 4); header.write('WAVE', 8)
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
    header.write('data', 36); header.writeUInt32LE(dataSize, 40)
    const wavBytes = Buffer.concat([header, Buffer.alloc(dataSize)])

    global.fetch = vi.fn(async () => new Response(wavBytes, {
      status: 200,
      headers: { 'Content-Type': 'audio/wav' },
    })) as unknown as typeof fetch

    const result = await generateSpeech({ model: 'sonic-3.5', transcript: 'Hello world', voiceId: 'v1' })

    expect(result).toMatchObject({ mimeType: 'audio/wav', durationSeconds: 2 })
    expect('audioBase64' in result && typeof result.audioBase64 === 'string').toBe(true)
  })

  it('returns a refused result when Cartesia returns a non-ok, non-throwing status', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'bad request' }), { status: 400 })) as unknown as typeof fetch

    await expect(generateSpeech({ model: 'sonic-3.5', transcript: 'Hello', voiceId: 'v1' }))
      .rejects.toThrow(/Cartesia speech generation failed/)
  })
})
