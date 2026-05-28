import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { retrieveChunks } from '@serverless-saas/ai'

export const retrieveDocumentsTool = createTool({
  id: 'retrieve_documents',
  description: `Search indexed documents in a folder.
Call this BEFORE answering ANY factual question.
Returns the most relevant chunks from uploaded documents with source and score.
If this returns no results, say you cannot find the information — never guess.`,

  inputSchema: z.object({
    query:    z.string().describe('What to search for'),
    folderId: z.string().describe('The folder ID to scope retrieval to'),
    tenantId: z.string().describe('The tenant ID'),
  }),

  outputSchema: z.object({
    found:   z.boolean(),
    context: z.string(),
  }),

  execute: async ({ query, folderId, tenantId }) => {
    const chunks = await retrieveChunks(query, tenantId, 5, 0.3, folderId || undefined)

    if (chunks.length === 0) {
      return {
        found:   false,
        context: 'No relevant content found in indexed documents for this query.',
      }
    }

    const context = chunks
      .map((c, i) => `[${i + 1}] ${c.documentName} (chunk ${c.chunkIndex}, score ${c.score.toFixed(3)})\n${c.content}`)
      .join('\n\n---\n\n')

    return { found: true, context }
  },
})
