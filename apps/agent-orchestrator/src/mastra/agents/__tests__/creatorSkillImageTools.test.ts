import { describe, it, expect } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { withoutDirectImageInCreatorSkills } from '../platformAgent.js'

const tools = { generate_image: 1, generate_images: 2, edit_image: 3, crop_image: 4, show_files: 5 }

function ctx(names?: string[]) {
  const rc = new RequestContext()
  if (names) rc.set('invokedSkillNames', names)
  return rc as never
}

describe('withoutDirectImageInCreatorSkills', () => {
  it('takes Olmo\'s own image tools away while a character creator skill is on', () => {
    for (const name of ['Animated character creator', 'Avatar creator', 'TVC character creator']) {
      expect(Object.keys(withoutDirectImageInCreatorSkills(tools, ctx([name])))).toEqual(['crop_image', 'show_files'])
    }
  })

  it('leaves them for every other turn', () => {
    expect(withoutDirectImageInCreatorSkills(tools, ctx(['Talking head']))).toEqual(tools)
    expect(withoutDirectImageInCreatorSkills(tools, ctx())).toEqual(tools)
  })
})
