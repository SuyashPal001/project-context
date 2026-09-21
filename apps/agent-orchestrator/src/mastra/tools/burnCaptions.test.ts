import { describe, it, expect } from 'vitest'
import { inputSchema, groupWordsIntoPhrases, formatSrtTimestamp, buildSrt } from './burnCaptions.js'

describe('burnCaptions inputSchema', () => {
  it('requires videoFileId and a non-empty words array', () => {
    const ok = inputSchema.safeParse({
      videoFileId: 'v1',
      words: [{ word: 'hi', startSeconds: 0, endSeconds: 0.3 }],
    })
    expect(ok.success).toBe(true)
    const empty = inputSchema.safeParse({ videoFileId: 'v1', words: [] })
    expect(empty.success).toBe(false)
  })
})

describe('groupWordsIntoPhrases', () => {
  it('groups words into phrases of up to 4, spanning first-word-start to last-word-end', () => {
    const words = [
      { word: 'the', startSeconds: 0.0, endSeconds: 0.2 },
      { word: 'quick', startSeconds: 0.2, endSeconds: 0.5 },
      { word: 'brown', startSeconds: 0.5, endSeconds: 0.8 },
      { word: 'fox', startSeconds: 0.8, endSeconds: 1.0 },
      { word: 'jumps', startSeconds: 1.1, endSeconds: 1.4 },
    ]
    const phrases = groupWordsIntoPhrases(words, 4)
    expect(phrases).toEqual([
      { text: 'the quick brown fox', startSeconds: 0.0, endSeconds: 1.0 },
      { text: 'jumps', startSeconds: 1.1, endSeconds: 1.4 },
    ])
  })
})

describe('formatSrtTimestamp', () => {
  it('formats seconds as HH:MM:SS,mmm', () => {
    expect(formatSrtTimestamp(0)).toBe('00:00:00,000')
    expect(formatSrtTimestamp(65.5)).toBe('00:01:05,500')
    expect(formatSrtTimestamp(3661.25)).toBe('01:01:01,250')
  })
})

describe('buildSrt', () => {
  it('renders numbered cues with SRT timestamps, including phrases with apostrophes safely', () => {
    const srt = buildSrt([
      { text: "it's here", startSeconds: 0, endSeconds: 1.2 },
      { text: 'don\'t wait', startSeconds: 1.3, endSeconds: 2.5 },
    ])
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,200\nit\'s here')
    expect(srt).toContain("2\n00:00:01,300 --> 00:00:02,500\ndon't wait")
  })
})
