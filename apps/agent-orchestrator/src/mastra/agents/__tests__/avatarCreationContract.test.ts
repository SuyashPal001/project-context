import { describe, it, expect } from 'vitest'
import { AVATAR_CREATION_CONTRACT, AVATAR_FROM_IMAGE_CONTRACT } from '../platformAgent.js'
import { AVATAR_CREATION_SECTION, AVATAR_FROM_IMAGE_SECTION } from '../directorAgent.js'

describe('avatar creation contract', () => {
  it('caps intake at one question and forbids a demographic quiz', () => {
    expect(AVATAR_CREATION_CONTRACT).toContain('at most ONE question')
    expect(AVATAR_CREATION_CONTRACT).toMatch(/never ask separately about gender, age or ethnicity/i)
    expect(AVATAR_CREATION_CONTRACT).toMatch(/never infer .* from a name/i)
  })

  it('requires fresh approval before regenerating rejected variations', () => {
    expect(AVATAR_CREATION_CONTRACT).toMatch(/none of these/i)
    expect(AVATAR_CREATION_CONTRACT).toMatch(/fresh cost estimate, fresh approval/i)
  })

  it('shows the reference sheet during testing and saves via save_as_avatar', () => {
    expect(AVATAR_CREATION_CONTRACT).toMatch(/show the reference sheet/i)
    expect(AVATAR_CREATION_SECTION).toContain('save_as_avatar')
    expect(AVATAR_CREATION_SECTION).toContain('generate_images')
    expect(AVATAR_CREATION_SECTION).toMatch(/referenceSheet is false/i)
  })

  it('never offers to regenerate a failed reference sheet — save_as_avatar always creates a new avatar, so accepting would duplicate it', () => {
    expect(AVATAR_CREATION_CONTRACT).not.toMatch(/offer to regenerate/i)
  })

  it('tells Olmo to pass the picked portrait\'s fileId explicitly to Director, since Director cannot see Olmo\'s working memory', () => {
    expect(AVATAR_CREATION_CONTRACT).toMatch(/pass that fileId explicitly/i)
  })

  it('limits demographic inference to what the user or the product\'s stated audience explicitly says, never a market or region', () => {
    expect(AVATAR_CREATION_CONTRACT).toMatch(/product's stated audience states/i)
    expect(AVATAR_CREATION_CONTRACT).not.toMatch(/product's stated audience implies/i)
    expect(AVATAR_CREATION_CONTRACT).toMatch(/never infer ethnicity from a market or region/i)
  })

  it('keeps terseTag and styleLock short — they are matched byte-for-byte in later prompts', () => {
    expect(AVATAR_CREATION_SECTION).toMatch(/terseTag \(10.40 characters/i)
    expect(AVATAR_CREATION_SECTION).toMatch(/styleLock \(under 80 characters/i)
  })
})

describe('image-to-avatar contract', () => {
  it('offers the two intents as a single-select question with the exact option labels', () => {
    expect(AVATAR_FROM_IMAGE_CONTRACT).toContain('Same person, restyled')
    expect(AVATAR_FROM_IMAGE_CONTRACT).toContain('A new person with this look')
  })

  it('never recreates a recognizable public figure — redirects to inspired-by instead', () => {
    expect(AVATAR_FROM_IMAGE_CONTRACT).toMatch(/never recreate a recognizable public figure/i)
  })

  it('passes the image fileId to Director explicitly, together with the intent and the brief', () => {
    expect(AVATAR_FROM_IMAGE_CONTRACT).toMatch(/pass .*fileId/i)
  })

  it('generates variations with referenceFileIds set to the user\'s image', () => {
    expect(AVATAR_FROM_IMAGE_SECTION).toContain('referenceFileIds')
  })

  it('inspired-by variations create a different person than the one in the reference', () => {
    expect(AVATAR_FROM_IMAGE_SECTION).toMatch(/different person, not the person in the reference/i)
  })

  it('uses the picked portrait — not the original photo — as the reference sheet\'s only reference', () => {
    expect(AVATAR_FROM_IMAGE_SECTION).toMatch(/picked portrait as its only reference/i)
  })
})
