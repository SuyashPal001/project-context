import { describe, it, expect } from 'vitest'
import { buildMusicBedFilter, inputSchema, parseIntegratedLoudness } from './mixMusicBed.js'

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

describe('buildMusicBedFilter (J6)', () => {
  it('is byte-identical without fadeOutAtSeconds (Review Focus 2)', () => {
    expect(buildMusicBedFilter()).toBe('[1:a]volume=0.35[bedvol];[bedvol][0:a]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=300[duckedbed];[0:a][duckedbed]amix=inputs=2:duration=longest:normalize=0[premaster];[premaster]loudnorm=I=-14:TP=-1.5:LRA=11[outa]')
  })
  it('fades the bed out over 0.5s ending at fadeOutAtSeconds', () => {
    expect(buildMusicBedFilter(12.3)).toContain('[1:a]volume=0.35,afade=t=out:st=11.8:d=0.5[bedvol]')
  })
  it('accepts fadeOutAtSeconds as optional', () => {
    expect(inputSchema.safeParse({ videoFileId: 'v', musicFileId: 'm', fadeOutAtSeconds: 12.3 }).success).toBe(true)
    expect(inputSchema.safeParse({ videoFileId: 'v', musicFileId: 'm', fadeOutAtSeconds: -1 }).success).toBe(false)
  })
})
