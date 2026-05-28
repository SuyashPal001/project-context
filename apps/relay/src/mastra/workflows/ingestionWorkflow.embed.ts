import { createStep } from '@mastra/core/workflows'
import * as crypto from 'crypto'
import { createRequire } from 'module'
import pg from 'pg'
import mammoth from 'mammoth'
import { validateOutputSchema, embedOutputSchema } from './ingestionWorkflow.schemas.js'

const _require = createRequire(import.meta.url)
const pdfParse = _require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>

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
  inputSchema: validateOutputSchema,
  outputSchema: embedOutputSchema,
  execute: async ({ inputData }) => {
    let textContent = inputData.extractedText
      ?? inputData.extractedFields.map(f => `${f.label}: ${f.value}`).join('\n')

    // Lambda sends bufferBase64 but no extractedText for text PDFs/DOCX — extract here
    if (!textContent && inputData.bufferBase64) {
      const buf = Buffer.from(inputData.bufferBase64, 'base64')
      if (inputData.mimeType === 'application/pdf') {
        try {
          const parsed = await pdfParse(buf)
          textContent = parsed.text ?? ''
        } catch (err) {
          console.warn('[embed] pdf-parse failed:', (err as Error).message)
        }
      } else if (
        inputData.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        inputData.mimeType === 'application/msword'
      ) {
        try {
          const res = await mammoth.extractRawText({ buffer: buf })
          textContent = res.value ?? ''
        } catch (err) {
          console.warn('[embed] mammoth failed:', (err as Error).message)
        }
      }
    }

    const chunks = chunkText(textContent)
    if (chunks.length === 0) {
      throw new Error('No text content extracted — 0 chunks produced. Ingestion failed.')
    }

    const client = await getPool().connect()
    let stored = 0
    try {
      // Upsert a documents row so document_chunks FK is satisfied
      // Use fileId as the hash — it's a UUID (36 chars), fits varchar(64), unique per tenant
      const docRes = await client.query(`
        INSERT INTO documents (id, tenant_id, name, file_key, mime_type, hash, status)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'ready')
        ON CONFLICT (tenant_id, hash) DO UPDATE SET
          name = EXCLUDED.name, mime_type = EXCLUDED.mime_type,
          status = 'ready', updated_at = now()
        RETURNING id
      `, [inputData.tenantId, inputData.filename, inputData.fileId, inputData.mimeType, inputData.fileId])
      const documentId: string = docRes.rows[0].id

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
          filename: inputData.filename,
          ...(inputData.personalIdentifier ? { personal_identifier: inputData.personalIdentifier } : {}),
        })
        const personFolderId = (inputData as any).personFolderId ?? null
        await client.query(`
          INSERT INTO document_chunks
            (id, tenant_id, document_id, content, embedding, chunk_index, metadata, tsv, person_folder_id)
          VALUES ($1, $2, $3, $4, $5::vector, $6, $7::jsonb, to_tsvector('english', $4), $8)
          ON CONFLICT (id) DO UPDATE SET
            content          = EXCLUDED.content,
            embedding        = EXCLUDED.embedding,
            metadata         = EXCLUDED.metadata,
            tsv              = EXCLUDED.tsv,
            person_folder_id = EXCLUDED.person_folder_id
        `, [id, inputData.tenantId, documentId, content, vectorStr, i, metadata, personFolderId])
        stored++
      }
      await client.query(
        `UPDATE documents SET chunk_count = $1, updated_at = now() WHERE id = $2`,
        [stored, documentId]
      )
    } finally {
      client.release()
    }

    console.log(`[embed] stored ${stored}/${chunks.length} chunks for fileId=${inputData.fileId}`)
    return { ...inputData, chunkCount: stored }
  },
})
