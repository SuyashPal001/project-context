import { retrieveChunks, type RetrievedChunk } from '@serverless-saas/ai'
import { rewriteQuery } from './queryRewrite.js'
import { fastGateChunks, gateChunks, type ScoredChunk } from './relevanceGate.js'

export interface RAGResult {
  context: string | null
  skipped: boolean
  reason?: string
}

const RETRIEVE_LIMIT = 20
const CONTEXT_CHUNK_LIMIT = 3

function toScoredChunk(r: RetrievedChunk): ScoredChunk {
  return { id: r.id, content: r.content, document_name: r.documentName, score: r.score }
}

async function fetchAndGate(query: string, tenantId: string, folderId: string): Promise<ScoredChunk[]> {
  const chunks = await retrieveChunks(query, tenantId, RETRIEVE_LIMIT, 0, folderId)
  if (chunks.length === 0) return []
  const fastGated = fastGateChunks(chunks.map(toScoredChunk), 0, RETRIEVE_LIMIT)
  if (fastGated.length === 0) return []
  return gateChunks(query, fastGated)
}

function buildContext(gated: ScoredChunk[]): string {
  const top = gated.slice(0, CONTEXT_CHUNK_LIMIT)
  const body = top.map((c, i) =>
    `[${i + 1}] Source: ${c.document_name} (relevance: ${c.relevanceScore}/3)\n${c.content}`
  ).join('\n\n')
  return `[KNOWLEDGE BASE CONTEXT]\nThe following is retrieved from the tenant's private documents. Cite the source document inline using [1], [2], etc.\n\n${body}\n\nIf the answer is not found above, say so clearly — do not invent information.`
}

export async function runRAGPipeline(
  message: string,
  history: { role: string; content: string }[],
  tenantId: string,
  folderId: string,
): Promise<RAGResult> {
  try {
    // First attempt
    const rewritten = await rewriteQuery(message, history)
    console.log(`[RAG] Query: "${message}" → "${rewritten}"`)

    const chunks = await retrieveChunks(rewritten, tenantId, RETRIEVE_LIMIT, 0, folderId)
    if (chunks.length === 0) {
      return { context: null, skipped: true, reason: 'no chunks retrieved' }
    }

    const fastGated = fastGateChunks(chunks.map(toScoredChunk), 0, RETRIEVE_LIMIT)
    if (fastGated.length === 0) {
      return { context: null, skipped: true, reason: 'no chunks retrieved' }
    }

    const gated = await gateChunks(rewritten, fastGated)

    if (gated.length > 0) {
      return { context: buildContext(gated), skipped: false }
    }

    // Retry: gate filtered everything — rewrite query with broader terms
    console.log('[RAG] Gate filtered all chunks — retrying with explicit rewrite')
    const retryQuery = await rewriteQuery(message, history)
    const retryGated = await fetchAndGate(retryQuery, tenantId, folderId)

    if (retryGated.length > 0) {
      return { context: buildContext(retryGated), skipped: false }
    }

    console.log('[RAG] Retry also filtered all chunks — skipping')
    return { context: null, skipped: true, reason: 'relevance gate filtered all chunks after retry' }

  } catch (err) {
    console.error('[RAG] Pipeline error:', err)
    return { context: null, skipped: true, reason: 'pipeline error' }
  }
}

export type { ScoredChunk }
