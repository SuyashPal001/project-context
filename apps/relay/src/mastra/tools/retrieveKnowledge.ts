import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

interface RawChunk {
  content: string
  documentName: string
  documentId: string
  source: 'document' | 'codebase'
  score: number
}

const requestContextSchema = z.object({
  tenantId: z.string(),
})

export const retrieveKnowledge = createTool({
  id: 'retrieve_knowledge',
  description: `Search the codebase knowledge base.
Call this for EVERY technical question about:
- How something works in this codebase
- What patterns are used
- What the data model looks like
- What APIs exist
- What tests cover an area
- What decisions were made
ALWAYS call this before answering any technical question.
Never answer from memory alone — always search first.`,
  requestContextSchema,
  inputSchema: z.object({
    query: z.string().describe('The search query'),
    layer: z
      .enum(['data', 'platform', 'system', 'infra', 'business'])
      .optional()
      .describe('Filter by layer if relevant'),
  }),
  outputSchema: z.object({
    context: z.string(),
    sourceCount: z.number(),
  }),
  execute: async (inputData, execContext) => {
    const query = (inputData as any)?.query ?? ''
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''

    const retrieveUrl =
      process.env.RETRIEVE_URL ?? 'http://localhost:3000/api/v1/internal/retrieve'
    const serviceKey = process.env.INTERNAL_SERVICE_KEY ?? ''

    let chunks: RawChunk[] = []

    try {
      const resp = await fetch(retrieveUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-service-key': serviceKey,
        },
        body: JSON.stringify({ query, tenantId, limit: 5, scoreThreshold: 0.3 }),
      })

      if (resp.ok) {
        const data = (await resp.json()) as { chunks?: unknown[] }
        chunks = Array.isArray(data.chunks) ? (data.chunks as RawChunk[]) : []
      } else {
        console.error(`[retrieveKnowledge] retrieve returned ${resp.status}`)
      }
    } catch (err) {
      console.error('[retrieveKnowledge] fetch error:', err)
    }

    // Keep only codebase chunks (documentId === 'knowledge' and source === 'codebase' always co-occur)
    const codebaseChunks = chunks.filter(
      (c) => c.documentId === 'knowledge' || c.source === 'codebase'
    )

    if (codebaseChunks.length === 0) {
      return { context: 'No relevant codebase references found.', sourceCount: 0 }
    }

    const n = codebaseChunks.length
    const formatted =
      `Found ${n} codebase reference${n === 1 ? '' : 's'}:\n\n` +
      codebaseChunks
        .map((c) => `[${c.documentName}]\n${c.content}`)
        .join('\n\n---\n\n')

    return { context: formatted, sourceCount: n }
  },
})
