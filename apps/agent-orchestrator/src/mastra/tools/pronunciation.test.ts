import { describe, it, expect } from 'vitest'
import { suspectWords, soundKey } from './pronunciation.js'

// Expected lines and Chirp 2's real transcripts of those clips (2026-10-05).
describe('suspectWords', () => {
  it('flags "bright" heard as "briny"', () => {
    const s = suspectWords('Okay, honestly, my skin has never looked this bright. I started using this vitamin C serum every morning.', 'okay honestly my skin has never looked this briny i started using this vitamin c serum every morning')
    expect(s).toEqual([{ meant: 'bright', heard: 'briny', context: 'skin has never looked this ___' }])
  })
  it('lets sound-alikes, units, plurals and possessives through', () => {
    expect(suspectWords('Okay so I just tried out this new gym tee and honestly the fit is incredible.', 'okay so i just tried out this new gym tea and honestly the fit is incredible')).toEqual([])
    expect(suspectWords("10 grams of protein and zero added sugar. Link's below, trust me.", '10 g of protein and zero added sugar links below trust me')).toEqual([])
    expect(suspectWords('it actually tastes like a light crispy wafer', 'no it actually taste like a light crispy wafer')).toEqual([])
  })
  it('passes a word Chirp misheard on to the second check', () => {
    expect(suspectWords('not a dense chalky bar', 'not a dense choki bar').map(s => s.meant)).toEqual(['chalky'])
  })
})

describe('soundKey', () => {
  it('matches homophones and separates different words', () => {
    expect(soundKey('tee')).toBe(soundKey('tea'))
    expect(soundKey('bright')).not.toBe(soundKey('briny'))
  })
})
