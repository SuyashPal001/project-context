import { describe, it, expect } from 'vitest'
import { fileTitle, fileTitleSchema } from '../fileTitle.js'
import { imageItemSchema } from '../generateImage.js'

describe('fileTitle', () => {
  it('keeps a clean human title', () => {
    expect(fileTitle('Maya at the bathroom vanity', 'Generated Image')).toBe('Maya at the bathroom vanity')
  })

  it('falls back when the agent gives nothing usable', () => {
    expect(fileTitle(undefined, 'Generated Image')).toBe('Generated Image')
    expect(fileTitle('   ', 'Generated Video')).toBe('Generated Video')
    expect(fileTitle('3f7a80a3-6285-4cbd-9e61-5f0b1c2d3e4f', 'Generated Image')).toBe('Generated Image')
  })

  it('strips ids, extensions and characters that break file names, and caps the length', () => {
    expect(fileTitle('Coffee / oak table: final.png', 'x')).toBe('Coffee oak table final')
    expect(fileTitle('shot 3f7a80a3-6285-4cbd-9e61-5f0b1c2d3e4f of a mug', 'x')).toBe('shot of a mug')
    expect(fileTitle('a'.repeat(100), 'x')).toHaveLength(60)
  })

  it('is an optional field on every image item', () => {
    expect(fileTitleSchema.safeParse(undefined).success).toBe(true)
    expect(imageItemSchema.safeParse({ prompt: 'p', title: 'Iced coffee on oak table' }).success).toBe(true)
  })
})
