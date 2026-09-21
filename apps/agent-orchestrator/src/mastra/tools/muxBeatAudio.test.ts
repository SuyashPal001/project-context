import { describe, it, expect } from 'vitest'
import { inputSchema } from './muxBeatAudio.js'

describe('muxBeatAudio inputSchema', () => {
  it('requires videoFileId and audioFileId', () => {
    const ok = inputSchema.safeParse({ videoFileId: 'v1', audioFileId: 'a1' })
    expect(ok.success).toBe(true)
    const missing = inputSchema.safeParse({ videoFileId: 'v1' })
    expect(missing.success).toBe(false)
  })
})
