import { describe, it, expect } from 'vitest'
import { buildVoiceoverFilter, inputSchema, loudnessProbeArgs, voiceoverFitsVideo, jingleGainDb, jingleWindow, speechInWindow, jingleOverlapErrors, clampJingleToVideo } from './mixVoiceover.js'

describe('mixVoiceover inputSchema', () => {
  it('needs a video and 1-5 blocks with non-negative starts', () => {
    expect(inputSchema.safeParse({ videoFileId: 'v', blocks: [{ audioFileId: 'a', startSeconds: 2 }] }).success).toBe(true)
    expect(inputSchema.safeParse({ videoFileId: 'v', blocks: [] }).success).toBe(false)
    expect(inputSchema.safeParse({ videoFileId: 'v', blocks: [{ audioFileId: 'a', startSeconds: -1 }] }).success).toBe(false)
  })
})

describe('buildVoiceoverFilter', () => {
  it('delays each block, ducks the base only while voice plays, and masters', () => {
    const f = buildVoiceoverFilter([{ start: 2, duration: 3.5 }, { start: 8, duration: 2 }], true)
    expect(f).toContain('[1:a]adelay=2000|2000[vo0]')
    expect(f).toContain('[2:a]adelay=8000|8000[vo1]')
    expect(f).toContain('[vo0][vo1]amix=inputs=2:duration=longest:normalize=0[vo]')
    expect(f).toContain("[0:a]volume=0.4:enable='between(t,2,5.5)+between(t,8,10)'[base]")
    expect(f).toContain('[base][vo]amix=inputs=2:duration=first:normalize=0[pre]')
    expect(f).toContain('[pre]loudnorm=I=-14:TP=-1.5:LRA=11[outa]')
  })
  it('uses the voice alone when the video has no audio, and a single block without amix', () => {
    const f = buildVoiceoverFilter([{ start: 0.5, duration: 2 }], false)
    expect(f).toContain('[1:a]adelay=500|500[vo0]')
    expect(f).toContain('[vo0]anull[vo]')
    expect(f).toContain('[vo]apad,loudnorm=I=-14:TP=-1.5:LRA=11[outa]')
    expect(f).not.toContain('[0:a]')
  })
})

describe('voiceoverFitsVideo', () => {
  it('refuses a block that runs past the end of the video', () => {
    expect(voiceoverFitsVideo([{ start: 2, duration: 8 }], 15)).toBe(true)
    expect(voiceoverFitsVideo([{ start: 10, duration: 6 }], 15)).toBe(false)
  })
})

describe('loudnessProbeArgs', () => {
  // ffmpeg 5.1 on the VM rejects framelog=quiet (see mix_music_bed, 3f5ec1c5).
  it('uses framelog=verbose, which ffmpeg 5.1 accepts', () => {
    const args = loudnessProbeArgs('/tmp/vo.wav')
    expect(args).toEqual(['-i', '/tmp/vo.wav', '-af', 'ebur128=framelog=verbose', '-f', 'null', '-'])
    expect(args.join(' ')).not.toContain('quiet')
  })
})

// Review Focus 2: a call without kind builds the same graph, byte for byte.
describe('legacy voiceover graphs are byte-identical', () => {
  it('two voice blocks over a video with sound', () => {
    expect(buildVoiceoverFilter([{ start: 2, duration: 3.5 }, { start: 8, duration: 2 }], true)).toBe(
      "[1:a]adelay=2000|2000[vo0];[2:a]adelay=8000|8000[vo1];[vo0][vo1]amix=inputs=2:duration=longest:normalize=0[vo];[0:a]volume=0.4:enable='between(t,2,5.5)+between(t,8,10)'[base];[base][vo]amix=inputs=2:duration=first:normalize=0[pre];[pre]loudnorm=I=-14:TP=-1.5:LRA=11[outa]",
    )
  })
  it('one voice block over a silent video', () => {
    expect(buildVoiceoverFilter([{ start: 0.5, duration: 2 }], false)).toBe('[1:a]adelay=500|500[vo0];[vo0]anull[vo];[vo]apad,loudnorm=I=-14:TP=-1.5:LRA=11[outa]')
  })
})

describe('jingle blocks (J6)', () => {
  it('a jingle block is gained, delayed, and neither ducks the base nor is ducked', () => {
    const f = buildVoiceoverFilter([{ start: 2, duration: 3.5 }, { start: 12.6, duration: 2.4, kind: 'jingle', gainDb: -6.5 }], true)
    expect(f).toContain('[2:a]volume=-6.5dB,adelay=12600|12600[vo1]')
    expect(f).toContain("[0:a]volume=0.4:enable='between(t,2,5.5)'[base]")
    expect(f).not.toContain('between(t,12.6')
  })
  it('a jingle with no voice blocks leaves the base at full level', () => {
    const f = buildVoiceoverFilter([{ start: 12.6, duration: 2.4, kind: 'jingle', gainDb: 0 }], true)
    expect(f).toContain('[0:a]anull[base]')
  })
  it('the probe graph mutes jingles and measures a window instead of mastering', () => {
    const f = buildVoiceoverFilter([{ start: 2, duration: 3.5 }, { start: 12.6, duration: 2.4, kind: 'jingle' }], true, 'atrim=start=7.6:end=12.6,ebur128=framelog=verbose', true)
    expect(f).toContain('[2:a]volume=0,adelay=12600|12600[vo1]')
    expect(f).toContain('[pre]atrim=start=7.6:end=12.6,ebur128=framelog=verbose[outa]')
    expect(f).not.toContain('loudnorm')
  })
  it('the window is the 5s before the block, or none when there is under 0.5s of it', () => {
    expect(jingleWindow(12.6)).toEqual({ from: 7.6, to: 12.6 })
    expect(jingleWindow(3)).toEqual({ from: 0, to: 3 })
    expect(jingleWindow(0.3)).toBeNull()
  })
  it('speech in the window is a voice block overlapping it', () => {
    const blocks = [{ start: 2, duration: 3.5 }, { start: 12.6, duration: 2.4, kind: 'jingle' as const }]
    expect(speechInWindow(blocks, 4, 9)).toBe(true)
    expect(speechInWindow(blocks, 6, 12.6)).toBe(false)
  })
  it('targets the speech level, or the base + 2 LU, clamped to ±12 dB', () => {
    expect(jingleGainDb(-20, -12, true)).toBe(-8)
    expect(jingleGainDb(-20, -12, false)).toBe(-6)
    expect(jingleGainDb(-20, -40, false)).toBe(12)
    expect(jingleGainDb(-30, -10, true)).toBe(-12)
    expect(jingleGainDb(null, -12, true)).toBe(0)
    expect(jingleGainDb(-70, -12, false)).toBe(0)
  })
  // F2: mix_voiceover checks the real measured speech against the jingle.
  it('refuses when a measured voice block ends too close to the jingle start', () => {
    const blocks = [{ start: 10, duration: 2 }, { start: 12.6, duration: 2.4, kind: 'jingle' as const }]
    expect(jingleOverlapErrors(blocks)).toEqual([
      'JINGLE_OVERLAPS_SPEECH: the voiceover ends 0.15s too close to the sung line; end the voiceover earlier',
    ])
  })
  it('passes when the measured voice block clears the jingle by 0.75s or more', () => {
    const blocks = [{ start: 10, duration: 1.85 }, { start: 12.6, duration: 2.4, kind: 'jingle' as const }]
    expect(jingleOverlapErrors(blocks)).toEqual([])
  })
  it('a mix with no jingle block is unchanged', () => {
    expect(jingleOverlapErrors([{ start: 2, duration: 3.5 }])).toEqual([])
  })
  // F3: no end-slack refusal for the jingle — it is laid to end with the video.
  it('clamps a jingle that would end past the video, so it ends with the video instead', () => {
    const blocks = [{ start: 12.6, duration: 2.4, kind: 'jingle' as const }]
    const [clamped] = clampJingleToVideo(blocks, 14.95)
    expect(clamped.start).toBeCloseTo(12.55, 5)
    expect(clamped.duration).toBe(2.4)
    expect(voiceoverFitsVideo(clampJingleToVideo(blocks, 14.95), 14.95)).toBe(true)
  })
  it('leaves a voice block alone — only the jingle is clamped', () => {
    const blocks = [{ start: 10, duration: 6 }]
    expect(clampJingleToVideo(blocks, 15)).toEqual(blocks)
  })
  it('leaves a jingle that already fits untouched', () => {
    const blocks = [{ start: 12.6, duration: 2.4, kind: 'jingle' as const }]
    expect(clampJingleToVideo(blocks, 15)).toEqual(blocks)
  })
  it('never clamps a jingle to a negative start, even if its duration exceeds the video', () => {
    const blocks = [{ start: 12.6, duration: 2.4, kind: 'jingle' as const }]
    const [clamped] = clampJingleToVideo(blocks, 1)
    expect(clamped.start).toBe(0)
  })
  it('accepts kind and up to 5 blocks; a legacy block still parses', () => {
    expect(inputSchema.safeParse({ videoFileId: 'v', blocks: [{ audioFileId: 'a', startSeconds: 2 }] }).success).toBe(true)
    expect(inputSchema.safeParse({ videoFileId: 'v', blocks: [{ audioFileId: 'a', startSeconds: 2, kind: 'jingle' }] }).success).toBe(true)
    expect(inputSchema.safeParse({ videoFileId: 'v', blocks: Array.from({ length: 5 }, () => ({ audioFileId: 'a', startSeconds: 1 })) }).success).toBe(true)
    expect(inputSchema.safeParse({ videoFileId: 'v', blocks: Array.from({ length: 6 }, () => ({ audioFileId: 'a', startSeconds: 1 })) }).success).toBe(false)
    expect(inputSchema.safeParse({ videoFileId: 'v', blocks: [{ audioFileId: 'a', startSeconds: 2, kind: 'song' }] }).success).toBe(false)
  })
})

describe('buildVoiceoverFilter room voice', () => {
  it('puts the narrator in the room only when asked, never on a jingle', async () => {
    const { buildVoiceoverFilter, ROOM_VOICE } = await import('./mixVoiceover.js')
    const blocks = [{ start: 0.3, duration: 2.2 }, { start: 5, duration: 2 }]
    expect(buildVoiceoverFilter(blocks, true)).not.toContain('aecho')
    const g = buildVoiceoverFilter(blocks, true, undefined, false, true)
    expect(g).toContain(`[1:a]${ROOM_VOICE}adelay=300|300[vo0]`)
    expect(g).toContain(`[2:a]${ROOM_VOICE}adelay=5000|5000[vo1]`)
    expect(buildVoiceoverFilter([{ start: 1, duration: 2, kind: 'jingle' as const }], true, undefined, false, true)).not.toContain('aecho')
  })
})
