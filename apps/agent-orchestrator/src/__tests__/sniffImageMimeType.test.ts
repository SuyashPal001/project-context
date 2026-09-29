import { describe, it, expect } from 'vitest'
import { sniffImageMimeType } from '../media.js'

describe('sniffImageMimeType', () => {
  it('reads the real type from the first bytes', () => {
    expect(sniffImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe('image/jpeg')
    expect(sniffImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(sniffImageMimeType(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'ascii'))).toBe('image/webp')
    expect(sniffImageMimeType(Buffer.from('GIF89a', 'ascii'))).toBe('image/gif')
  })

  it('returns null for anything else, so the caller keeps its own type', () => {
    expect(sniffImageMimeType(Buffer.from('%PDF-1.7', 'ascii'))).toBeNull()
    expect(sniffImageMimeType(Buffer.from([]))).toBeNull()
  })
})
