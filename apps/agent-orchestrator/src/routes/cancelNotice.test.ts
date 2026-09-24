import { describe, it, expect } from 'vitest'
import { cancelSubject, buildCancelNotice, trackBackgroundDecline, waitForBackgroundDecline } from './cancelNotice.js'

describe('cancelSubject', () => {
  it('keeps the user words minus request boilerplate', () => {
    expect(cancelSubject('generate an image of a tvc character')).toBe('tvc character')
    expect(cancelSubject('Can you please make me a picture of a red car?')).toBe('red car')
    expect(cancelSubject('a cozy reading nook')).toBe('cozy reading nook')
  })
  it('caps at 8 words', () => {
    expect(cancelSubject('a poster for a coffee shop called Bean There with a tagline')).toBe('poster for a coffee shop called Bean There…')
  })
  it('returns empty for pure boilerplate', () => {
    expect(cancelSubject('generate an image')).toBe('image')
    expect(cancelSubject('   ')).toBe('')
  })
})

describe('buildCancelNotice', () => {
  it('single image with aspect ratio', () => {
    expect(buildCancelNotice('generate_image', { aspectRatio: '16:9' }, 'generate an image of a tvc character'))
      .toBe('Cancelled: tvc character image (16:9). Nothing was generated. Want to change anything and try again?')
  })
  it('hyphenated tool id works the same', () => {
    expect(buildCancelNotice('generate-image', {}, '')).toBe('Cancelled the image. Nothing was generated. Want to change anything and try again?')
  })
  it('batch counts items', () => {
    expect(buildCancelNotice('generate_images', { items: [{}, {}, {}], aspectRatio: '9:16' }, 'three red cars'))
      .toBe('Cancelled: 3 images of three red cars (9:16). Nothing was generated. Want to change anything and try again?')
  })
  it('edit says the original is unchanged', () => {
    expect(buildCancelNotice('edit_image', {}, 'make the sky pink')).toContain('The original is unchanged')
  })
  it('skill save', () => {
    expect(buildCancelNotice('save_skill', {}, 'save this as a skill')).toBe('Skill not saved.')
  })
})

describe('background decline tracking', () => {
  it('returns none when nothing is pending', async () => {
    expect(await waitForBackgroundDecline('c-none')).toBe('none')
  })
  it('waits for a pending decline to finish', async () => {
    let done!: () => void
    trackBackgroundDecline('c1', new Promise<void>((r) => { done = r }))
    setTimeout(() => done(), 10)
    expect(await waitForBackgroundDecline('c1', 1000)).toBe('finished')
    expect(await waitForBackgroundDecline('c1')).toBe('none')
  })
  it('gives up at the cap', async () => {
    trackBackgroundDecline('c2', new Promise<void>(() => {}))
    expect(await waitForBackgroundDecline('c2', 20)).toBe('timed_out')
  })
})
