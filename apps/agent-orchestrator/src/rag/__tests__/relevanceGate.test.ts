import { describe, it, expect, vi } from 'vitest'

// Must be declared before importing relevanceGate — vitest hoists vi.mock calls.
// quickGeminiCall is only used in gateChunks (LLM path); fastGateChunks is pure.
vi.mock('../../llm/quickCall.js', () => ({
  quickGeminiCall: vi.fn(),
}))

import { fastGateChunks } from '../relevanceGate.js'
import type { ScoredChunk } from '../relevanceGate.js'

function chunk(id: string, score: number): ScoredChunk {
  return { id, content: 'some content', document_name: 'doc.pdf', score }
}

describe('fastGateChunks', () => {
  it('returns only chunks at or above the score threshold, sorted descending', () => {
    const chunks = [chunk('a', 0.9), chunk('b', 0.6), chunk('c', 0.3)]
    // c is below 0.5 — must be excluded after removing the || i < 3 guard
    const result = fastGateChunks(chunks, 0.5, 5)
    expect(result.map(c => c.id)).toEqual(['a', 'b'])
  })

  it('returns [] when all chunks score below the threshold', () => {
    // Confirms the || i < 3 bug is gone — no implicit top-3 retention
    const chunks = [chunk('a', 0.01), chunk('b', 0.01), chunk('c', 0.01)]
    expect(fastGateChunks(chunks, 0.5, 5)).toHaveLength(0)
  })

  it('sets relevanceScore to 2 on every returned chunk', () => {
    const chunks = [chunk('x', 0.8), chunk('y', 0.7)]
    const result = fastGateChunks(chunks, 0.5, 5)
    for (const c of result) {
      expect(c.relevanceScore).toBe(2)
    }
  })

  it('honours the limit parameter', () => {
    const chunks = Array.from({ length: 10 }, (_, i) => chunk(`c${i}`, 0.9))
    expect(fastGateChunks(chunks, 0.5, 4)).toHaveLength(4)
  })
})
