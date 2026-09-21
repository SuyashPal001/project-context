import { describe, it, expect } from 'vitest'
import { inputSchema } from './compositeEndCard.js'

describe('compositeEndCard inputSchema', () => {
  it('requires videoFileId, productPhotoFileId, and aspectRatio', () => {
    const ok = inputSchema.safeParse({ videoFileId: 'v1', productPhotoFileId: 'p1', aspectRatio: '9:16' })
    expect(ok.success).toBe(true)
    const missing = inputSchema.safeParse({ videoFileId: 'v1', productPhotoFileId: 'p1' })
    expect(missing.success).toBe(false)
  })
})
