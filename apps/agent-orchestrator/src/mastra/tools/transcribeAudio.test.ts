import { describe, it, expect } from 'vitest'
import { inputSchema } from './transcribeAudio.js'

describe('transcribeAudio inputSchema', () => {
  it('requires fileId', () => {
    const ok = inputSchema.safeParse({ fileId: 'f1' })
    expect(ok.success).toBe(true)
    const missing = inputSchema.safeParse({})
    expect(missing.success).toBe(false)
  })
})
