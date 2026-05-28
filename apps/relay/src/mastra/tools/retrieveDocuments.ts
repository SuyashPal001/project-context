import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import pg from 'pg'

const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const SCORE_THRESHOLD = 0.3

let _pool: pg.Pool | null = null
function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    _pool.on('error', (err) => console.error('[retrieveDocuments] pool error:', (err as Error).message))
  }
  return _pool
}

async function embedQuery(query: string): Promise<number[]> {
  const res = await fetch(`${INFERENCE_GATEWAY_URL}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-004', input: query }),
  })
  if (!res.ok) throw new Error(`Embedding gateway ${res.status}`)
  const data = await res.json() as { data: Array<{ embedding: number[] }> }
  return data.data[0].embedding
}

async function search(query: string, tenantId: string, folderId: string, limit = 15) {
  const embedding = await embedQuery(query)
  const vectorStr = `[${embedding.join(',')}]`
  const client = await getPool().connect()
  try {
    const result = await client.query(`
      SELECT
        dc.content,
        dc.chunk_index,
        COALESCE(dc.metadata->>'filename', 'document') AS document_name,
        (1 - (dc.embedding <=> $1::vector)) AS score
      FROM document_chunks dc
      WHERE dc.tenant_id = $2
        AND (
          dc.person_folder_id = $3
          OR dc.document_id IN (
            SELECT doc.id FROM documents doc
            WHERE doc.tenant_id = $2
              AND doc.hash IN (
                SELECT f.id::text FROM files f
                WHERE f.tenant_id   = $2
                  AND f.deleted_at IS NULL
                  AND f.key LIKE (
                    SELECT pf.identifier || '/%'
                    FROM person_folders pf
                    WHERE pf.id = $3
                    LIMIT 1
                  )
              )
          )
        )
        AND (1 - (dc.embedding <=> $1::vector)) >= $4
      ORDER BY dc.embedding <=> $1::vector
      LIMIT $5
    `, [vectorStr, tenantId, folderId, SCORE_THRESHOLD, limit])
    return result.rows as Array<{ content: string; chunk_index: number; document_name: string; score: number }>
  } finally {
    client.release()
  }
}

const requestContextSchema = z.object({
  tenantId: z.string(),
})

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

  requestContextSchema,

  outputSchema: z.object({
    found:   z.boolean(),
    context: z.string(),
  }),

  execute: async ({ query, folderId }, execContext) => {
    const tenantId = (execContext as any)?.requestContext?.get('tenantId') as string | undefined
      ?? (execContext as any)?.context?.tenantId as string | undefined
      ?? ''
    if (!tenantId) {
      console.error('[retrieveDocuments] tenantId missing from requestContext')
      return { found: false, context: 'Document retrieval failed: missing tenant context.' }
    }
    let rows: Awaited<ReturnType<typeof search>>
    try {
      rows = await search(query, tenantId, folderId)
    } catch (err) {
      console.error('[retrieveDocuments] search threw:', (err as Error).message)
      return { found: false, context: 'Document retrieval failed. Please try again.' }
    }

    if (rows.length === 0) {
      return { found: false, context: 'No relevant content found in indexed documents for this query.' }
    }

    const context = rows
      .map((r, i) => `[${i + 1}] ${r.document_name} (chunk ${r.chunk_index}, score ${r.score.toFixed(3)})\n${r.content}`)
      .join('\n\n---\n\n')

    return { found: true, context }
  },
})
