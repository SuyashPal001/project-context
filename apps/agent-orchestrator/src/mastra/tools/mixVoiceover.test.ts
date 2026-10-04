import { describe, it, expect } from 'vitest'
import { buildVoiceoverFilter, inputSchema, voiceoverFitsVideo } from './mixVoiceover.js'

describe('mixVoiceover inputSchema', () => {
  it('needs a video and 1-4 blocks with non-negative starts', () => {
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
