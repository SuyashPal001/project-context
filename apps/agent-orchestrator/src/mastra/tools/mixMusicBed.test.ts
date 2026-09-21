import { describe, it, expect } from 'vitest'
import { inputSchema, parseIntegratedLoudness } from './mixMusicBed.js'

describe('mixMusicBed inputSchema', () => {
  it('requires videoFileId and musicFileId', () => {
    const ok = inputSchema.safeParse({ videoFileId: 'v1', musicFileId: 'm1' })
    expect(ok.success).toBe(true)
    const missing = inputSchema.safeParse({ videoFileId: 'v1' })
    expect(missing.success).toBe(false)
  })
})

describe('parseIntegratedLoudness', () => {
  it('extracts the Integrated LUFS value from ebur128 stderr output', () => {
    const stderr = [
      '[Parsed_ebur128_0 @ 0x1] t: 3.0 TARGET:-23 M:-27.3 S:-27.1 I: -26.4 LUFS',
      'Summary:',
      '',
      '  Integrated loudness:',
      '    I:         -26.4 LUFS',
      '    Threshold: -36.5 LUFS',
    ].join('\n')
    expect(parseIntegratedLoudness(stderr)).toBe(-26.4)
  })

  it('returns null when no Integrated loudness line is present', () => {
    expect(parseIntegratedLoudness('garbage output with no match')).toBeNull()
  })
})
