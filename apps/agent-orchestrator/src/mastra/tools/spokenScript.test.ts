import { describe, it, expect } from 'vitest'
import { changedEarlierWords, cleanSpokenStart, recordSpoken, spokenSoFar } from './spokenScript.js'

describe('spokenSoFar', () => {
  it('carries every earlier line into a continued clip', () => {
    recordSpoken('c1', { approvedDialogue: 'My skin has never looked this bright.', interactionId: 'i1', fileId: 'f1' })
    recordSpoken('c1', { continueFrom: 'i1', approvedDialogue: 'I use it every morning.', interactionId: 'i2', fileId: 'f2' })
    recordSpoken('c1', { continueFrom: 'i2', approvedDialogue: 'Try it.', interactionId: 'i3', fileId: 'f3' })
    expect(spokenSoFar('c1', 'f1')).toEqual(['My skin has never looked this bright.'])
    expect(spokenSoFar('c1', 'f3')).toEqual(['My skin has never looked this bright.', 'I use it every morning.', 'Try it.'])
    expect(spokenSoFar('c2', 'f3')).toBeUndefined()
  })
})

describe('cleanSpokenStart', () => {
  it('drops leading dots so the model does not invent a lead-in word', () => {
    expect(cleanSpokenStart('...it actually tastes like a wafer.')).toBe('it actually tastes like a wafer.')
    expect(cleanSpokenStart('… it tastes good')).toBe('it tastes good')
    expect(cleanSpokenStart('Okay so, and honestly...')).toBe('Okay so, and honestly...')
  })
})

describe('changedEarlierWords', () => {
  const earlier = ['Okay, honestly, my skin has never looked this bright.']
  it('flags an earlier line re-voiced with a different word', () => {
    expect(changedEarlierWords(earlier, 'Okay, honestly, my skin has never looked this brighting, I started using this serum')).toEqual(['bright'])
    expect(changedEarlierWords(earlier, 'Okay honestly my skin has never looked this glowing.')).toEqual(['bright'])
  })
  it('passes the same words, and ignores short words and numbers', () => {
    expect(changedEarlierWords(earlier, 'Okay, honestly, my skin has never looked this bright. I started using it.')).toEqual([])
    expect(changedEarlierWords(['It has 10 grams in a bar.'], 'It has ten grams in the bar')).toEqual([])
  })
})
