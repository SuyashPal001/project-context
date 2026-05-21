import * as crypto from 'crypto';
import { v5 as uuidv5 } from 'uuid';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { sql } from 'drizzle-orm';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { getOrEmbedTexts } from '@serverless-saas/ai';
import { db } from '../db';
import { extractQuestions } from '../rag/extractQuestions';

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-south-1' });
const CHUNK_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;
const DOCUMENTS_BUCKET = process.env.DOCUMENTS_BUCKET!;

// ── Deterministic chunk UUID ──────────────────────────────
function chunkId(documentId: string, chunkIndex: number): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${documentId}:${chunkIndex}`)
    .digest('hex');
  return uuidv5(hash, CHUNK_NAMESPACE);
}

// ── Text cleaning + chunking ──────────────────────────────
function chunkText(text: string): string[] {
  const clean = text
    .replace(/Page \d+ of \d+/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\0/g, '')
    .trim();

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = start + CHUNK_SIZE;
    if (end < clean.length) {
      const lastSpace = clean.lastIndexOf(' ', end);
      if (lastSpace > start) end = lastSpace;
    }
    const chunk = clean.slice(start, end).trim();
    if (chunk.length > 50) chunks.push(chunk);
    start = end - CHUNK_OVERLAP;
    if (start < 0) start = 0;
  }
  return chunks;
}

// ── Parse file content ────────────────────────────────────
async function parseFile(buffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType === 'application/pdf') {
    const result = await pdfParse(buffer);
    return result.text;
  }

  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (mimeType === 'text/plain') {
    return buffer.toString('utf-8');
  }

  throw new Error(`Unsupported mimeType: ${mimeType}`);
}

// ── Main handler ──────────────────────────────────────────
export interface DocumentIngestPayload {
  tenantId: string;
  documentId: string;
  fileKey: string;
  mimeType: string;
}

export async function handleDocumentIngest(payload: DocumentIngestPayload): Promise<void> {
  const { tenantId, documentId, fileKey, mimeType } = payload;

  // 1. Mark as processing
  await db.execute(sql`
    UPDATE documents
    SET status = 'processing', updated_at = NOW()
    WHERE id = ${documentId} AND tenant_id = ${tenantId}
  `);

  try {
    // 2. Download from S3
    const s3Response = await s3.send(new GetObjectCommand({
      Bucket: DOCUMENTS_BUCKET,
      Key: fileKey,
    }));
    const chunks_arr = [];
    if (s3Response.Body) {
      for await (const chunk of s3Response.Body as AsyncIterable<Uint8Array>) {
        chunks_arr.push(chunk);
      }
    }
    const buffer = Buffer.concat(chunks_arr);

    // 3. Parse text
    const text = await parseFile(buffer, mimeType);
    if (!text || text.trim().length === 0) {
      throw new Error('Parsed text is empty');
    }

    // 4. Chunk text
    const textChunks = chunkText(text);
    if (textChunks.length === 0) {
      throw new Error('No chunks generated');
    }

    // 5. Embed all chunks (with cache)
    const embedded = await getOrEmbedTexts(textChunks, 'RETRIEVAL_DOCUMENT');

    // 6. Delete existing chunks (re-ingest is idempotent)
    await db.execute(sql`
      DELETE FROM document_chunks WHERE document_id = ${documentId}
    `);

    // 7. Insert chunks with embeddings + extracted questions
    for (let i = 0; i < embedded.length; i++) {
      const { text: content, embedding } = embedded[i];
      const id = chunkId(documentId, i);
      const vectorStr = `[${embedding.join(',')}]`;

      // Extract questions this chunk answers — silent fail, never blocks ingestion
      const questions = await extractQuestions(content);

      const metadata = {
        chunk_index: i,
        total_chunks: embedded.length,
        char_start: text.indexOf(content),
        char_end: text.indexOf(content) + content.length,
        source: mimeType === 'application/pdf' ? 'pdf'
              : mimeType.includes('word') ? 'docx'
              : 'txt',
        ingested_at: new Date().toISOString(),
        questions,
      };

      // tsvSource = content + questions text so BM25 matches vocabulary from both
      const tsvSource = questions.length > 0
        ? `${content} ${questions.join(' ')}`
        : content;

      await db.execute(sql`
        INSERT INTO document_chunks
          (id, tenant_id, document_id, content, embedding, chunk_index, metadata, tsv)
        VALUES (
          ${id},
          ${tenantId},
          ${documentId},
          ${content},
          ${vectorStr}::vector,
          ${i},
          ${JSON.stringify(metadata)}::jsonb,
          to_tsvector('english', ${tsvSource})
        )
        ON CONFLICT (id) DO UPDATE SET
          content = EXCLUDED.content,
          embedding = EXCLUDED.embedding,
          metadata = EXCLUDED.metadata,
          tsv = EXCLUDED.tsv
      `);
    }

    // 8. Mark as ready
    await db.execute(sql`
      UPDATE documents
      SET status = 'ready',
          chunk_count = ${embedded.length},
          updated_at = NOW()
      WHERE id = ${documentId} AND tenant_id = ${tenantId}
    `);

    console.log(`[documentIngest] done: documentId=${documentId} chunks=${embedded.length}`);

  } catch (error) {
    // 9. Mark as failed
    const message = error instanceof Error ? error.message : String(error);
    await db.execute(sql`
      UPDATE documents
      SET status = 'failed',
          error = ${message},
          updated_at = NOW()
      WHERE id = ${documentId} AND tenant_id = ${tenantId}
    `);
    console.error(`[documentIngest] failed: documentId=${documentId} error=${message}`);
    throw error; // re-throw so SQS retries
  }
}
