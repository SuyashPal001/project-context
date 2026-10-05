import { describe, it, expect } from 'vitest'
import { cleanSpokenStart, recordSpoken, spokenSoFar } from './spokenScript.js'

describe('spokenSoFar', () => {
  it('carries every earlier line into a continued clip', () => {
    recordSpoken('c1', { approvedDialogue: 'My skin has never looked this bright.', interactionId: 'i1', fileId: 'f1' })
    recordSpoken('c1', { continueFrom: 'i1', approvedDialogue: 'I use it every morning.', interactionId: 'i2', fileId: 'f2' })
    recordSpoken('c1', { continueFrom: 'i2', approvedDialogue: 'Try it.', interactionId: 'i3', fileId: 'f3' })
    expect(spokenSoFar('c1', 'f1')).toBe('My skin has never looked this bright.')
    expect(spokenSoFar('c1', 'f3')).toBe('My skin has never looked this bright. I use it every morning. Try it.')
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
