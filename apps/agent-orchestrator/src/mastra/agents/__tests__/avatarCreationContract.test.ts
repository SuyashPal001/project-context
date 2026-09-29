import { describe, it, expect } from 'vitest'
import { AVATAR_CREATION_CONTRACT } from '../platformAgent.js'
import { AVATAR_CREATION_SECTION } from '../directorAgent.js'

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
})
