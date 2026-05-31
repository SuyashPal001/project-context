import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@serverless-saas/ai', () => ({
  retrieveChunks: vi.fn(),
}))

vi.mock('../queryRewrite.js', () => ({
  rewriteQuery: vi.fn(),
}))

vi.mock('../relevanceGate.js', () => ({
  fastGateChunks: vi.fn(),
  gateChunks: vi.fn(),
}))

import { retrieveChunks } from '@serverless-saas/ai'
import { rewriteQuery } from '../queryRewrite.js'
import { fastGateChunks, gateChunks } from '../relevanceGate.js'
import { runRAGPipeline } from '../index.js'

const mockRetrieve = vi.mocked(retrieveChunks)
const mockRewrite = vi.mocked(rewriteQuery)
const mockFastGate = vi.mocked(fastGateChunks)
const mockGate = vi.mocked(gateChunks)

function makeChunk(id: string, score = 0.8) {
  return { id, content: `content ${id}`, chunkIndex: 0, metadata: {}, documentName: 'doc.pdf', documentId: 'doc-1', score, source: 'document' as const }
}

function makeScoredChunk(id: string) {
  return { id, content: `content ${id}`, document_name: 'doc.pdf', score: 0.8, relevanceScore: 3 }
}

describe('runRAGPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRewrite.mockImplementation(async (msg) => msg)
    mockFastGate.mockImplementation((chunks) => chunks.map(c => ({ ...c, relevanceScore: 2 })))
  })

  it('returns context when gate passes chunks', async () => {
    const chunk = makeChunk('c1')
    mockRetrieve.mockResolvedValue([chunk])
    mockGate.mockResolvedValue([makeScoredChunk('c1')])

    const result = await runRAGPipeline('what is gratuity limit', [], 'tenant-1', 'folder-1')

    expect(result.skipped).toBe(false)
    expect(result.context).toContain('KNOWLEDGE BASE CONTEXT')
  })

  it('returns skipped when no chunks retrieved', async () => {
    mockRetrieve.mockResolvedValue([])
    mockFastGate.mockReturnValue([])
    mockGate.mockResolvedValue([])

    const result = await runRAGPipeline('unknown query', [], 'tenant-1', 'folder-1')

    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('no chunks retrieved')
  })

  it('retries with rewritten query when gate returns empty on first attempt', async () => {
    const chunk = makeChunk('c1')
    // First call returns chunks but gate filters all out
    // Second call (retry) returns chunks that pass gate
    mockRetrieve
      .mockResolvedValueOnce([chunk])
      .mockResolvedValueOnce([chunk])
    mockGate
      .mockResolvedValueOnce([])          // first attempt: gate filters everything
      .mockResolvedValueOnce([makeScoredChunk('c1')]) // retry: gate passes

    mockRewrite
      .mockResolvedValueOnce('what is gratuity limit')  // first rewrite
      .mockResolvedValueOnce('gratuity limit CCS rules pension') // retry rewrite

    const result = await runRAGPipeline('what is gratuity limit', [], 'tenant-1', 'folder-1')

    expect(result.skipped).toBe(false)
    expect(mockRetrieve).toHaveBeenCalledTimes(2)
  })

  it('returns skipped when retry also fails gate', async () => {
    const chunk = makeChunk('c1')
    mockRetrieve.mockResolvedValue([chunk])
    mockGate.mockResolvedValue([]) // always filters everything

    mockRewrite
      .mockResolvedValueOnce('what is gratuity limit')
      .mockResolvedValueOnce('gratuity limit CCS rules')

    const result = await runRAGPipeline('what is gratuity limit', [], 'tenant-1', 'folder-1')

    expect(result.skipped).toBe(true)
    expect(result.reason).toContain('retry')
  })
})
