import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { retrieveChunks, type RetrievedChunk } from '@serverless-saas/ai'
import { fastGateChunks, gateChunks, type ScoredChunk } from '../../rag/relevanceGate.js'

const RETRIEVE_LIMIT = 20
const CONTEXT_CHUNK_LIMIT = 5

function toScoredChunk(r: RetrievedChunk): ScoredChunk {
  return {
    id: r.id,
    content: r.content,
    document_name: r.documentName,
    score: r.score,
  }
}

const requestContextSchema = z.object({
  tenantId: z.string(),
})

export const retrieveDocumentsTool = createTool({
  id: 'retrieve_documents',
  description: `Search the workspace's indexed documents.
Call this BEFORE answering ANY factual question.
Returns the most relevant chunks from uploaded documents with source and score.
If this returns no results, say you cannot find the information — never guess.`,

  inputSchema: z.object({
    query:    z.string().optional().default('document summary').describe('What to search for — use the user\'s question or topic. Defaults to a broad summary search if omitted.'),
  }),

  requestContextSchema,

  outputSchema: z.object({
    found:   z.boolean(),
    context: z.string(),
    sources: z.array(z.object({ name: z.string(), score: z.number() })).optional(),
  }),

  execute: async ({ query }, execContext) => {
    const tenantId = (execContext as any)?.requestContext?.get('tenantId') as string | undefined
      ?? (execContext as any)?.context?.tenantId as string | undefined
      ?? ''
    // Scope is granted server-side and is not negotiable by the model: a tool
    // argument naming a folder would let the agent widen its own reach to any
    // folder in the tenant.
    const folderId = (execContext as any)?.requestContext?.get('folderId') as string | undefined

    if (!tenantId) {
      console.error('[retrieveDocuments] tenantId missing from requestContext')
      return { found: false, context: 'Document retrieval failed: missing tenant context.' }
    }

    let chunks: RetrievedChunk[]
    try {
      chunks = await retrieveChunks(query, tenantId, RETRIEVE_LIMIT, 0, folderId)
    } catch (err) {
      console.error('[retrieveDocuments] retrieveChunks threw:', (err as Error).message)
      return { found: false, context: 'Document retrieval failed. Please try again.' }
    }

    if (chunks.length === 0) {
      return { found: false, context: 'No relevant content found in indexed documents for this query.' }
    }

    // Fast gate: score threshold filter — no LLM, instant
    const scoredChunks = chunks.map(toScoredChunk)
    const fastGated = fastGateChunks(scoredChunks, 0, RETRIEVE_LIMIT)

    if (fastGated.length === 0) {
      return { found: false, context: 'No relevant content found in indexed documents for this query.' }
    }

    // LLM gate: Gemini scores each chunk 0-3, keeps score >= 2
    let gated: ScoredChunk[]
    try {
      gated = await gateChunks(query, fastGated)
    } catch (err) {
      console.error('[retrieveDocuments] gateChunks threw, using fast-gated results:', (err as Error).message)
      gated = fastGated
    }

    if (gated.length === 0) {
      return { found: false, context: 'No relevant content found in indexed documents for this query.' }
    }

    const top = gated.slice(0, CONTEXT_CHUNK_LIMIT)
    const context = top
      .map((r, i) => `[${i + 1}] ${r.document_name} (relevance: ${r.relevanceScore ?? r.score.toFixed(3)})\n${r.content}`)
      .join('\n\n---\n\n')

    // Deduplicate sources by document name, keep highest score per doc
    const sourceMap = new Map<string, number>()
    for (const r of top) {
      const prev = sourceMap.get(r.document_name) ?? 0
      const score = typeof r.relevanceScore === 'number' ? r.relevanceScore : r.score
      if (score > prev) sourceMap.set(r.document_name, score)
    }
    const sources = Array.from(sourceMap.entries()).map(([name, score]) => ({ name, score }))

    return { found: true, context, sources }
  },
})
