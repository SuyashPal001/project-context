import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

interface RawChunk {
  content: string
  document_name: string
  score: number
}

const requestContextSchema = z.object({
  tenantId: z.string(),
  agentId: z.string().optional(),
  userId: z.string().optional(),
})

export const fetchAgentContext = createTool({
  id: 'fetch-agent-context',
  description: 'Fetches product/company context for a tenant from the knowledge base using semantic search.',
  requestContextSchema,
  inputSchema: z.object({
    query: z.string(),
  }),
  outputSchema: z.object({
    context: z.string(),
    sourceCount: z.number(),
  }),
  execute: async (inputData, execContext) => {
    const query = inputData?.query ?? ''
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    if (!tenantId || tenantId === 'default') {
      return { context: '', sourceCount: 0 }
    }

    const apiBaseUrl = process.env.API_BASE_URL ?? ''
    const serviceKey = process.env.INTERNAL_SERVICE_KEY ?? ''

    let chunks: RawChunk[] = []

    try {
      const resp = await fetch(`${apiBaseUrl}/api/v1/internal/retrieve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-service-key': serviceKey,
        },
        body: JSON.stringify({ query, tenantId, limit: 5, scoreThreshold: 0.3 }),
      })

      if (resp.ok) {
        const data = await resp.json() as { chunks?: unknown[] }
        chunks = Array.isArray(data.chunks) ? (data.chunks as RawChunk[]) : []
      } else {
        console.error(`[fetchAgentContext] retrieve returned ${resp.status}`)
      }
    } catch (err) {
      console.error('[fetchAgentContext] fetch error:', err)
    }

    if (chunks.length === 0) {
      return { context: '', sourceCount: 0 }
    }

    const combined = chunks.map(c => c.content).join('\n\n')
    return { context: combined, sourceCount: chunks.length }
  },
})
