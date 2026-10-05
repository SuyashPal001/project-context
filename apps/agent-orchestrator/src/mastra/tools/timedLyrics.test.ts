import { describe, it, expect } from 'vitest'
import { findLine, lineOverlap, parseTimedLyrics } from './timedLyrics.js'

// The Chai line is verbatim from the 2026-10-05 Lyria 3 run; the lines around
// it are filler in the same format.
const CHAI = [
  'Here is your jingle.',
  '[Chorus]',
  '[0.0:4.6] Garam chai, subah ki baat',
  '[9.4:14.9] Chai Nation, mazaa baar baar',
].join('\n')
const BUBBLI = '[0.0:6.2] Every bubble, every sip\n[22.1:25.0] Bubbli, feel the magic'
// Decomposed nukta (ज + ◌़) in the sung text; the wanted text below uses the precomposed ज़ (U+095B).
const HINDI = '[15.2:19.0] चाय नेशन, मज़ा बार बार'

describe('parseTimedLyrics (J2)', () => {
  it('reads [start:end] lines and ignores everything else', () => {
    expect(parseTimedLyrics(CHAI)).toEqual([
      { start: 0, end: 4.6, text: 'Garam chai, subah ki baat' },
      { start: 9.4, end: 14.9, text: 'Chai Nation, mazaa baar baar' },
    ])
  })
  it('drops a line whose end is not after its start, and an empty text', () => {
    expect(parseTimedLyrics('[5.0:5.0] same\n[6.0:4.0] backwards\n[1.0:2.0]   \n[1.0:2.5] ok')).toEqual([{ start: 1, end: 2.5, text: 'ok' }])
  })
  it('accepts CRLF and spaces around the colon', () => {
    expect(parseTimedLyrics('[ 1.5 : 3 ] hello\r\n')).toEqual([{ start: 1.5, end: 3, text: 'hello' }])
  })
})

describe('findLine (J2)', () => {
  it('finds the Chai sign-off with different punctuation and case', () => {
    expect(findLine(parseTimedLyrics(CHAI), 'chai nation — Mazaa baar baar!')).toEqual({ start: 9.4, end: 14.9, text: 'Chai Nation, mazaa baar baar' })
  })
  it('finds the Bubbli sign-off', () => {
    expect(findLine(parseTimedLyrics(BUBBLI), 'Bubbli, feel the magic')?.start).toBe(22.1)
  })
  it('finds a Hindi line in Devanagari, keeping vowel signs and nukta', () => {
    expect(findLine(parseTimedLyrics(HINDI), 'चाय नेशन, मज़ा बार बार')?.start).toBe(15.2)
  })
  it('returns null when the line was not sung', () => {
    expect(findLine(parseTimedLyrics(BUBBLI), 'Bubbli, taste the sparkle')).toBeNull()
    expect(findLine([], 'anything')).toBeNull()
  })
  it('needs at least 0.8 of the wanted words', () => {
    expect(lineOverlap('Bubbli feel the magic today', 'Bubbli, feel the magic')).toBe(0.8)
    expect(findLine(parseTimedLyrics(BUBBLI), 'Bubbli feel the magic today')?.start).toBe(22.1)
    expect(findLine(parseTimedLyrics(BUBBLI), 'Bubbli feel the real magic today')).toBeNull()
  })
  it('prefers the later of two equally good lines (the ending)', () => {
    const twice = '[3.0:5.0] Bubbli, feel the magic\n[22.1:25.0] Bubbli, feel the magic'
    expect(findLine(parseTimedLyrics(twice), 'Bubbli, feel the magic')?.start).toBe(22.1)
  })
})
