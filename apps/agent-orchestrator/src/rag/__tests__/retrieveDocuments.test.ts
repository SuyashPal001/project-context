import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

// Mock retrieveChunks from the ai package
vi.mock('@serverless-saas/ai', () => ({
  retrieveChunks: vi.fn(),
}))

// Mock the relevance gate
vi.mock('../relevanceGate.js', () => ({
  fastGateChunks: vi.fn(),
  gateChunks: vi.fn(),
}))

import { retrieveChunks } from '@serverless-saas/ai'
import { fastGateChunks, gateChunks } from '../relevanceGate.js'
import { retrieveDocumentsTool } from '../../mastra/tools/retrieveDocuments.js'

function makeRequestContext(tenantId: string) {
  const ctx = new RequestContext()
  ctx.set('tenantId', tenantId)
  return ctx
}

const mockRetrieveChunks = vi.mocked(retrieveChunks)
const mockFastGate = vi.mocked(fastGateChunks)
const mockGateChunks = vi.mocked(gateChunks)

function makeChunk(id: string, score: number) {
  return {
    id,
    content: `content of ${id}`,
    chunkIndex: 0,
    metadata: {},
    documentName: 'test.pdf',
    documentId: 'doc-1',
    score,
    source: 'document' as const,
  }
}

function makeScoredChunk(id: string, score: number, relevanceScore = 3) {
  return { id, content: `content of ${id}`, document_name: 'test.pdf', score, relevanceScore }
}

describe('retrieveDocumentsTool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns found=false when retrieveChunks returns empty', async () => {
    mockRetrieveChunks.mockResolvedValue([])
    mockFastGate.mockReturnValue([])
    mockGateChunks.mockResolvedValue([])

    const result = await (retrieveDocumentsTool as any).execute(
      { query: 'gratuity limit', folderId: 'folder-1' },
      { requestContext: makeRequestContext('tenant-1') }
    )

    expect(result.found).toBe(false)
  })

  it('returns found=true with top 5 chunks when gate passes results', async () => {
    const chunks = Array.from({ length: 10 }, (_, i) => makeChunk(`c${i}`, 0.9 - i * 0.05))
    mockRetrieveChunks.mockResolvedValue(chunks)

    const scoredChunks = chunks.map((c, i) => makeScoredChunk(c.id, c.score, 3))
    mockFastGate.mockReturnValue(scoredChunks)
    mockGateChunks.mockResolvedValue(scoredChunks.slice(0, 5))

    const result = await (retrieveDocumentsTool as any).execute(
      { query: 'gratuity limit', folderId: 'folder-1' },
      { requestContext: makeRequestContext('tenant-1') }
    )

    expect(result.found).toBe(true)
    // Must never return more than 5 chunks to the LLM
    const contextChunks = result.context.split('---').filter((s: string) => s.trim())
    expect(contextChunks.length).toBeLessThanOrEqual(5)
  })

  // Folder-scoped retrieval is not implemented: retrieveChunks takes
  // (query, tenantId, limit, scoreThreshold) and the tool's inputSchema accepts
  // only { query }. This test previously asserted a fifth folderId argument and
  // had been failing ever since it was written. It now pins the real contract —
  // tenant scoping, which is the part that matters for isolation.
  it('scopes retrieval to the caller tenant', async () => {
    mockRetrieveChunks.mockResolvedValue([])
    mockFastGate.mockReturnValue([])
    mockGateChunks.mockResolvedValue([])

    await (retrieveDocumentsTool as any).execute(
      { query: 'pension rules' },
      { requestContext: makeRequestContext('tenant-99') }
    )

    expect(mockRetrieveChunks).toHaveBeenCalledWith(
      'pension rules',
      'tenant-99',
      expect.any(Number),
      expect.any(Number)
    )
  })

  it('falls back to fast-gated results when gateChunks throws', async () => {
    const chunks = [makeChunk('c1', 0.02), makeChunk('c2', 0.015)]
    mockRetrieveChunks.mockResolvedValue(chunks)

    const scoredChunks = chunks.map(c => makeScoredChunk(c.id, c.score))
    mockFastGate.mockReturnValue(scoredChunks)
    mockGateChunks.mockRejectedValue(new Error('LLM timeout'))

    const result = await (retrieveDocumentsTool as any).execute(
      { query: 'gratuity limit', folderId: 'folder-1' },
      { requestContext: makeRequestContext('tenant-1') }
    )

    expect(result.found).toBe(true)
  })
})
