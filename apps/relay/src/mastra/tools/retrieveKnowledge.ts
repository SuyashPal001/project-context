import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import pg from 'pg'

let _pool: pg.Pool | null = null

function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    _pool.on('error', (err) => {
      console.error('[retrieveKnowledge] pool error:', err.message)
    })
  }
  return _pool
}

async function embedQuery(query: string): Promise<number[] | null> {
  const proxyUrl = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
  try {
    const resp = await fetch(`${proxyUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-004', input: query }),
    })
    if (!resp.ok) {
      console.warn('[retrieveKnowledge] embed failed:', resp.status)
      return null
    }
    const data = await resp.json() as { data: Array<{ embedding: number[] }> }
    return data.data[0]?.embedding ?? null
  } catch (err) {
    console.warn('[retrieveKnowledge] embed error:', (err as Error).message)
    return null
  }
}

interface ChunkRow {
  id: string
  content: string
  file_path: string
  layer: string
  file_type: string
  vec_dist: number
  text_rank: number
}

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

  inputSchema: z.object({
    query: z.string(),
    layer: z
      .enum(['data', 'platform', 'system', 'infra', 'business'])
      .optional()
      .describe('Filter by layer if relevant'),
  }),

  outputSchema: z.object({
    context: z.string(),
    sourceCount: z.number(),
  }),

  execute: async (inputData) => {
    const query = (inputData as any)?.query ?? ''
    const layer = (inputData as any)?.layer as string | undefined

    const vector = await embedQuery(query)
    console.log('[retrieve_knowledge] vector dims:', vector?.length ?? 'null - text fallback')

    const client = await getPool().connect()
    let rows: ChunkRow[] = []

    try {
      if (vector) {
        const vectorStr = `[${vector.join(',')}]`
        const params: unknown[] = [vectorStr, query]
        let sql = `
          SELECT id, content, file_path, layer, file_type,
                 embedding <=> $1::vector AS vec_dist,
                 ts_rank(tsv, websearch_to_tsquery('english', $2)) AS text_rank
          FROM knowledge_chunks
          WHERE tenant_id IS NULL
            AND invalidated_at IS NULL
            AND (
              embedding <=> $1::vector < 0.7
              OR tsv @@ websearch_to_tsquery('english', $2)
            )`
        if (layer) {
          params.push(layer)
          sql += ` AND layer = $${params.length}`
        }
        sql += ' ORDER BY vec_dist ASC LIMIT 5'
        const result = await client.query<ChunkRow>(sql, params)
        rows = result.rows
      } else {
        const params: unknown[] = [query]
        let sql = `
          SELECT id, content, file_path, layer, file_type,
                 0 AS vec_dist,
                 ts_rank(tsv, websearch_to_tsquery('english', $1)) AS text_rank
          FROM knowledge_chunks
          WHERE tenant_id IS NULL
            AND invalidated_at IS NULL
            AND tsv @@ websearch_to_tsquery('english', $1)`
        if (layer) {
          params.push(layer)
          sql += ` AND layer = $${params.length}`
        }
        sql += ' ORDER BY text_rank DESC LIMIT 5'
        const result = await client.query<ChunkRow>(sql, params)
        rows = result.rows
      }
    } finally {
      client.release()
    }

    console.log('[retrieve_knowledge] rows returned:', rows.length)
    console.log('[retrieve_knowledge] files:', rows.map(r => r.file_path).join(', '))

    if (rows.length === 0) {
      return { context: `No relevant codebase references found for: ${query}`, sourceCount: 0 }
    }

    const formatted =
      `Found ${rows.length} codebase reference${rows.length === 1 ? '' : 's'}:\n\n` +
      rows.map((r) => `[${r.file_path}] (${r.layer})\n${r.content}`).join('\n\n---\n\n')

    console.log('[retrieve_knowledge] context length:', formatted.length, 'chars')
    console.log('[retrieve_knowledge] sourceCount:', rows.length)

    return { context: formatted, sourceCount: rows.length }
  },
})
