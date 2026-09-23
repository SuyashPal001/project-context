import { describe, it, expect, vi } from 'vitest'

vi.mock('@serverless-saas/credits', () => ({ isUnlimited: vi.fn(), resolveRate: vi.fn() }))

import { GENERATION_APPROVAL_METADATA } from './generationApproval.js'

describe('batch generation approval metadata', () => {
  it.each(['generate-videos', 'generate_videos'])('%s prices as video generation with count = item count', (name) => {
    const meta = GENERATION_APPROVAL_METADATA[name]
    expect(meta).toMatchObject({ resourceType: 'video_generation', subject: 'google/gemini-omni-1.1-flash', label: 'Generate videos' })
    expect(meta.buildCount!({ items: [{}, {}, {}] })).toBe(3)
  })

  it.each(['generate-images', 'generate_images'])('%s prices as image generation with count = item count', (name) => {
    const meta = GENERATION_APPROVAL_METADATA[name]
    expect(meta).toMatchObject({ resourceType: 'image_generation', subject: 'gemini-3-pro-image-preview', label: 'Generate images' })
    expect(meta.buildCount!({ items: [{}, {}] })).toBe(2)
  })

  it('returns no count when items is missing or not an array', () => {
    expect(GENERATION_APPROVAL_METADATA['generate_videos'].buildCount!({})).toBeUndefined()
    expect(GENERATION_APPROVAL_METADATA['generate_videos'].buildCount!({ items: 'x' })).toBeUndefined()
  })

  it('leaves single-item tools without a count', () => {
    expect(GENERATION_APPROVAL_METADATA['generate_video'].buildCount).toBeUndefined()
    expect(GENERATION_APPROVAL_METADATA['generate_image'].buildCount).toBeUndefined()
  })
})
