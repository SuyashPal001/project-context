import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { INTERNAL_API_URL, INTERNAL_SERVICE_KEY } from '../../types.js'

export const retrievePensionDocTool = createTool({
  id: 'retrieve_pension_doc',
  description: `Search indexed pension documents for a specific pensioner.
Call this BEFORE answering ANY factual question about a pension case.
Returns chunks from the pensioner's uploaded documents with source and chunk number.
If this returns no results, say you cannot find the information — never guess.`,

  inputSchema: z.object({
    query:          z.string().describe('What to search for, e.g. "last drawn pay qualifying service years"'),
    personFolderId: z.string().describe('The person folder ID to scope retrieval to'),
    tenantId:       z.string().describe('The tenant ID'),
  }),

  outputSchema: z.object({
    found:   z.boolean(),
    chunks:  z.array(z.object({
      content:      z.string(),
      documentName: z.string(),
      chunkIndex:   z.number(),
      score:        z.number(),
    })),
    context: z.string(),
  }),

  execute: async ({ query, personFolderId, tenantId }) => {
    const res = await fetch(`${INTERNAL_API_URL}/internal/retrieve`, {
      method:  'POST',
      headers: {
        'Content-Type':          'application/json',
        'x-internal-service-key': INTERNAL_SERVICE_KEY,
      },
      body: JSON.stringify({ query, tenantId, personFolderId, limit: 5, scoreThreshold: 0.3 }),
    })

    if (!res.ok) {
      return { found: false, chunks: [], context: `Retrieval service error: ${res.status}` }
    }

    const data = await res.json() as { context: string; chunks: Array<{ content: string; documentName: string; chunkIndex: number; score: number }> }

    if (!data.chunks || data.chunks.length === 0) {
      return {
        found:   false,
        chunks:  [],
        context: 'No relevant content found in indexed documents for this query.',
      }
    }

    return {
      found:   true,
      chunks:  data.chunks.map(c => ({
        content:      c.content,
        documentName: c.documentName,
        chunkIndex:   c.chunkIndex,
        score:        c.score,
      })),
      context: data.context,
    }
  },
})
