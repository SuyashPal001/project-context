import { describe, expect, it } from 'vitest'
import { stripStudioLighting } from './adRealism.js'

describe('stripStudioLighting', () => {
  it('drops the softbox the image model drew into a gym shot', () => {
    expect(stripStudioLighting('the man in the green t-shirt in a gym setting, natural gym softbox lighting, 35mm camera.'))
      .toBe('the man in the green t-shirt in a gym setting, natural gym lighting, 35mm camera.')
  })
  it('turns studio lighting into natural light and removes ring lights', () => {
    expect(stripStudioLighting('Bright studio lighting, ring light on her face.')).toBe('Bright natural light, on her face.')
  })
  it('never touches quoted dialogue', () => {
    expect(stripStudioLighting('softbox glow. He says: "My studio lighting is a softbox."')).toBe('glow. He says: "My studio lighting is a softbox."')
  })
})
