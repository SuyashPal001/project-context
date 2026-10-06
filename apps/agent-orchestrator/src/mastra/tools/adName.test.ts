import { describe, expect, it } from 'vitest'
import { adBaseFromClipTitle, finishedAdTitle, noteClipTitle } from './fileTitle.js'

describe('finished ad name', () => {
  it('takes the product part of a clip title', () => {
    expect(adBaseFromClipTitle('Avvatar Whey - Beat 1 Video')).toBe('Avvatar Whey')
    expect(adBaseFromClipTitle('Piko Scene 2 kitchen')).toBe('Piko')
    expect(adBaseFromClipTitle('Bubbli: Hook clip')).toBe('Bubbli')
    expect(adBaseFromClipTitle('Maya at the bathroom vanity')).toBeNull()
    expect(adBaseFromClipTitle('Beat 1 Video')).toBeNull()
  })
  it('names the finishing steps "<product> ad" once a clip named one', () => {
    expect(finishedAdTitle('c-none', 'Beat with End Card')).toBe('Beat with End Card')
    noteClipTitle('c1', 'Avvatar Whey - Beat 3 Video')
    expect(finishedAdTitle('c1', 'Beat with End Card')).toBe('Avvatar Whey ad')
    noteClipTitle('c2', 'Summer launch ad - Beat 1')
    expect(finishedAdTitle('c2', 'Final Video')).toBe('Summer launch ad')
  })
})
