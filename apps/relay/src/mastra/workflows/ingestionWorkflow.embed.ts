import { createStep } from '@mastra/core/workflows'
import * as crypto from 'crypto'
import pg from 'pg'
import { commitOutputSchema, embedOutputSchema } from './ingestionWorkflow.schemas.js'

const CHUNK_SIZE = 1000
const CHUNK_OVERLAP = 200

let _pool: pg.Pool | null = null
function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
    _pool.on('error', (err) => console.error('[embed] pool error:', (err as Error).message))
  }
  return _pool
}

// Deterministic UUID from documentId + chunkIndex — no external uuid dep needed
function chunkId(documentId: string, index: number): string {
  const h = crypto.createHash('sha256').update(`${documentId}:${index}`).digest('hex')
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`
}

// Copied exactly from apps/worker/src/handlers/documentIngest.ts
function chunkText(text: string): string[] {
  const clean = text
    .replace(/Page \d+ of \d+/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\0/g, '')
    .trim()
  const chunks: string[] = []
  let start = 0
  while (start < clean.length) {
    let end = start + CHUNK_SIZE
    if (end < clean.length) {
      const lastSpace = clean.lastIndexOf(' ', end)
      if (lastSpace > start) end = lastSpace
    }
    const chunk = clean.slice(start, end).trim()
    if (chunk.length > 50) chunks.push(chunk)
    start = end - CHUNK_OVERLAP
    if (start < 0) start = 0
  }
  return chunks
}

async function embedText(text: string): Promise<number[] | null> {
  const proxyUrl = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
  try {
    const resp = await fetch(`${proxyUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-004', input: text }),
    })
    if (!resp.ok) {
      console.warn('[embed] embed failed:', resp.status, await resp.text())
      return null
    }
    const data = await resp.json() as { data: Array<{ embedding: number[] }> }
    return data.data[0]?.embedding ?? null
  } catch (err) {
    console.warn('[embed] embed error:', (err as Error).message)
    return null
  }
}

export const embedStep = createStep({
  id: 'ingestion-embed',
  inputSchema: commitOutputSchema,
  outputSchema: embedOutputSchema,
  execute: async ({ inputData }) => {
    const textContent = inputData.extractedText
      ?? inputData.extractedFields.map(f => `${f.label}: ${f.value}`).join('\n')

    const chunks = chunkText(textContent)
    if (chunks.length === 0) {
      console.warn('[embed] no chunks generated for fileId:', inputData.fileId)
      return { ...inputData, chunkCount: 0 }
    }

    const client = await getPool().connect()
    let stored = 0
    try {
      for (let i = 0; i < chunks.length; i++) {
        const content = chunks[i]
        const embedding = await embedText(content)
        if (!embedding) {
          console.warn('[embed] skipping chunk', i, '— embed returned null')
          continue
        }
        const id = chunkId(inputData.fileId, i)
        const vectorStr = `[${embedding.join(',')}]`
        const metadata = JSON.stringify({
          chunk_index: i,
          total_chunks: chunks.length,
          source: inputData.mimeType?.includes('pdf') ? 'pdf'
                : inputData.mimeType?.includes('word') ? 'docx'
                : 'txt',
          ingested_at: new Date().toISOString(),
        })
        await client.query(`
          INSERT INTO document_chunks
            (id, tenant_id, document_id, content, embedding, chunk_index, metadata, tsv)
          VALUES ($1, $2, $3, $4, $5::vector, $6, $7::jsonb, to_tsvector('english', $4))
          ON CONFLICT (id) DO UPDATE SET
            content   = EXCLUDED.content,
            embedding = EXCLUDED.embedding,
            metadata  = EXCLUDED.metadata,
            tsv       = EXCLUDED.tsv
        `, [id, inputData.tenantId, inputData.fileId, content, vectorStr, i, metadata])
        stored++
      }
    } finally {
      client.release()
    }

    console.log(`[embed] stored ${stored}/${chunks.length} chunks for fileId=${inputData.fileId}`)
    return { ...inputData, chunkCount: stored }
  },
})
