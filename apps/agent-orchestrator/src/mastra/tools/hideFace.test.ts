// The original's frame is shown to an image model only for the pose; its person's face leaked into ours
// (fan run real15). The face is blurred out first, from the pose reader's head box.
import { describe, it, expect } from 'vitest'
import { hideFaceArgs } from './hideFace.js'

describe('hideFaceArgs', () => {
  it('blurs only the head box, placed by fractions of the frame', () => {
    const a = hideFaceArgs('/in.jpg', '/out.jpg', [0.4, 0.2, 0.6, 0.35])
    expect(a.slice(0, 4)).toEqual(['-y', '-i', '/in.jpg', '-filter_complex'])
    expect(a[4]).toBe('[0]split[a][b];[b]crop=iw*0.2:ih*0.15:iw*0.4:ih*0.2,boxblur=30:4[f];[a][f]overlay=main_w*0.4:main_h*0.2')
    expect(a.at(-1)).toBe('/out.jpg')
  })
})
