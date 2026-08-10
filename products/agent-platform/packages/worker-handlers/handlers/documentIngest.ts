import * as crypto from 'crypto';
import { v5 as uuidv5 } from 'uuid';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { sql } from 'drizzle-orm';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { getOrEmbedTexts, generateTextVertex } from '@serverless-saas/ai';
import { db } from '../db';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { extractQuestions } from '../rag/extractQuestions';
import { safeExtractZip, isZipArchive, ZipSafetyError, type SafeZipEntry } from '../lib/safeZip';

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

// ── Contextual blurb generation ───────────────────────────
async function generateContextBlurb(
  documentText: string,
  chunk: string,
  documentName: string,
): Promise<string> {
  // Use first 8000 chars of document for context — enough to understand structure
  const docSample = documentText.slice(0, 8000);
  const prompt = `Here is a document and one chunk extracted from it. Write 2-3 sentences describing what this chunk is about and where it fits in the document. Be specific about the document name, section, rule number, or topic. Output only the description, no preamble.

Document name: ${documentName}
Document (first 8000 chars):
${docSample}

Chunk:
${chunk}

Description:`;

  try {
    const blurb = await generateTextVertex({
      prompt,
      model: 'gemini-2.0-flash',
      maxTokens: 150,
      temperature: 0,
    });
    return blurb.trim();
  } catch (err) {
    console.warn('[documentIngest] generateContextBlurb failed, using raw chunk:', err instanceof Error ? err.message : String(err));
    return '';
  }
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

function inferMimeTypeFromExtension(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.');
  const ext = dot === -1 ? '' : fileName.slice(dot).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === '.txt') return 'text/plain';
  return null;
}

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ── Chunk, embed and store — shared by a single uploaded document and by
// each entry extracted from a zip archive. Caller owns the document row's
// 'processing' status and failure handling; this only ever leaves it 'ready'.
async function ingestParsedText(params: {
  tenantId: string;
  documentId: string;
  mimeType: string;
  documentName: string;
  text: string;
}): Promise<number> {
  const { tenantId, documentId, mimeType, documentName, text } = params;

  if (!text || text.trim().length === 0) {
    throw new Error('Parsed text is empty');
  }

  const textChunks = chunkText(text);
  if (textChunks.length === 0) {
    throw new Error('No chunks generated');
  }

  const contextualChunks: string[] = [];
  for (const chunk of textChunks) {
    const blurb = await generateContextBlurb(text, chunk, documentName);
    contextualChunks.push(blurb ? `[CONTEXT: ${blurb}]\n\n${chunk}` : chunk);
  }

  const embedded = await getOrEmbedTexts(contextualChunks, 'RETRIEVAL_DOCUMENT');

  await db.execute(sql`
    DELETE FROM document_chunks WHERE document_id = ${documentId}
  `);

  // Look up person_folder_id so chunks are folder-scoped for RAG
  const fileRow = await db.execute(sql`
    SELECT person_folder_id FROM files WHERE id = ${documentId} LIMIT 1
  `)
  const personFolderId = (fileRow as any).rows?.[0]?.person_folder_id ?? null

  for (let i = 0; i < embedded.length; i++) {
    const content = contextualChunks[i];
    const { embedding } = embedded[i];
    const id = chunkId(documentId, i);
    const vectorStr = `[${embedding.join(',')}]`;

    const rawChunk = textChunks[i];

    // Extract questions this chunk answers — silent fail, never blocks ingestion
    // Use raw chunk (no blurb prefix) so question extraction operates on original text
    const questions = await extractQuestions(rawChunk);
    const metadata = {
      chunk_index: i,
      total_chunks: embedded.length,
      char_start: text.indexOf(rawChunk),
      char_end: text.indexOf(rawChunk) + rawChunk.length,
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
        (id, tenant_id, document_id, content, embedding, chunk_index, metadata, tsv, person_folder_id)
      VALUES (
        ${id},
        ${tenantId},
        ${documentId},
        ${content},
        ${vectorStr}::vector,
        ${i},
        ${JSON.stringify(metadata)}::jsonb,
        to_tsvector('english', ${tsvSource}),
        ${personFolderId}
      )
      ON CONFLICT (id) DO UPDATE SET
        content = EXCLUDED.content,
        embedding = EXCLUDED.embedding,
        metadata = EXCLUDED.metadata,
        tsv = EXCLUDED.tsv,
        person_folder_id = EXCLUDED.person_folder_id
    `);
  }

  await db.execute(sql`
    UPDATE documents
    SET status = 'ready',
        chunk_count = ${embedded.length},
        updated_at = NOW()
    WHERE id = ${documentId} AND tenant_id = ${tenantId}
  `);

  return embedded.length;
}

interface ZipEntryResult {
  status: 'ingested' | 'duplicate' | 'failed';
  fileName: string;
  documentId?: string;
  chunkCount?: number;
  reason?: string;
}

async function ingestZipEntry(
  tenantId: string,
  uploadedBy: string | null,
  parentFileKey: string,
  entry: SafeZipEntry,
  index: number,
): Promise<ZipEntryResult> {
  const mimeType = inferMimeTypeFromExtension(entry.fileName);
  if (!mimeType) {
    return { status: 'failed', fileName: entry.fileName, reason: 'could not infer a supported mime type' };
  }

  const hash = sha256Hex(entry.buffer);
  const baseName = (entry.fileName.split('/').pop() ?? entry.fileName).replace(/[^a-zA-Z0-9._-]/g, '_');

  const existing = await db.execute(sql`
    SELECT id FROM documents WHERE tenant_id = ${tenantId} AND hash = ${hash} LIMIT 1
  `);
  const existingId = (existing as any).rows?.[0]?.id;
  if (existingId) {
    return { status: 'duplicate', fileName: entry.fileName, documentId: existingId };
  }

  const entryKey = `${parentFileKey}.entries/${index}-${baseName}`;
  const documentId = crypto.randomUUID();

  try {
    await s3.send(new PutObjectCommand({
      Bucket: DOCUMENTS_BUCKET,
      Key: entryKey,
      Body: entry.buffer,
      ContentType: mimeType,
    }));

    await db.execute(sql`
      INSERT INTO documents (id, tenant_id, uploaded_by, name, file_key, mime_type, hash, status, metadata)
      VALUES (${documentId}, ${tenantId}, ${uploadedBy}, ${baseName}, ${entryKey}, ${mimeType}, ${hash}, 'processing',
        ${JSON.stringify({ extractedFromZip: true })}::jsonb)
    `);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'failed', fileName: entry.fileName, reason: `could not store entry: ${message}` };
  }

  try {
    const text = await parseFile(entry.buffer, mimeType);
    const chunkCount = await ingestParsedText({ tenantId, documentId, mimeType, documentName: baseName, text });
    return { status: 'ingested', fileName: entry.fileName, documentId, chunkCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.execute(sql`
      UPDATE documents SET status = 'failed', error = ${message}, updated_at = NOW()
      WHERE id = ${documentId} AND tenant_id = ${tenantId}
    `);
    return { status: 'failed', fileName: entry.fileName, documentId, reason: message };
  }
}

// A zip is expanded into one document per supported entry inside it — the
// archive's own document row never gets text/chunks of its own, it just
// becomes a record of what it expanded into. One bad entry inside an
// otherwise-good archive should not fail the rest of the archive; only
// evidence of an actual attack (zip bomb, path traversal) rejects the
// whole upload instead of a single entry.
async function handleZipDocument(tenantId: string, documentId: string, fileKey: string, buffer: Buffer): Promise<void> {
  let extraction;
  try {
    extraction = await safeExtractZip(buffer);
  } catch (err) {
    const message = err instanceof ZipSafetyError || err instanceof Error ? err.message : String(err);
    await db.execute(sql`
      UPDATE documents SET status = 'failed', error = ${message}, updated_at = NOW()
      WHERE id = ${documentId} AND tenant_id = ${tenantId}
    `);
    db.insert(auditLog).values({ tenantId, actorId: 'system', actorType: 'system', action: 'document_archive_rejected', resource: 'document', resourceId: documentId, metadata: { error: message }, traceId: '' }).catch(() => {});
    console.error(`[documentIngest] zip rejected: documentId=${documentId} reason=${message}`);
    return;
  }

  const parentRow = await db.execute(sql`SELECT uploaded_by FROM documents WHERE id = ${documentId} LIMIT 1`);
  const uploadedBy = (parentRow as any).rows?.[0]?.uploaded_by ?? null;

  const results: ZipEntryResult[] = [];
  for (let i = 0; i < extraction.accepted.length; i++) {
    results.push(await ingestZipEntry(tenantId, uploadedBy, fileKey, extraction.accepted[i], i));
  }

  const ingested = results.filter(r => r.status === 'ingested');
  const duplicates = results.filter(r => r.status === 'duplicate');
  const failed = results.filter(r => r.status === 'failed');

  await db.execute(sql`
    UPDATE documents
    SET status = 'ready', chunk_count = 0, updated_at = NOW(),
        metadata = ${JSON.stringify({
          archive: true,
          expandedInto: ingested.length,
          alreadyIndexed: duplicates.length,
          skipped: extraction.skipped,
          failedEntries: failed.map(f => ({ fileName: f.fileName, reason: f.reason })),
        })}::jsonb
    WHERE id = ${documentId} AND tenant_id = ${tenantId}
  `);

  db.insert(auditLog).values({
    tenantId, actorId: 'system', actorType: 'system',
    action: 'document_archive_expanded', resource: 'document', resourceId: documentId,
    metadata: { ingested: ingested.length, duplicates: duplicates.length, skipped: extraction.skipped.length, failed: failed.length },
    traceId: '',
  }).catch(() => {});

  console.log(`[documentIngest] zip expanded: documentId=${documentId} ingested=${ingested.length} duplicates=${duplicates.length} skipped=${extraction.skipped.length} failed=${failed.length}`);
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

    // 3. Archives fan out into one document per supported entry instead of
    // being parsed as a single file — handleZipDocument owns its own status
    // transitions and never throws for entry-level failures.
    if (isZipArchive(mimeType, fileKey)) {
      await handleZipDocument(tenantId, documentId, fileKey, buffer);
      return;
    }

    // 4. Parse, chunk, embed, store
    const text = await parseFile(buffer, mimeType);
    const documentName = fileKey.split('/').pop() ?? fileKey;
    const chunkCount = await ingestParsedText({ tenantId, documentId, mimeType, documentName, text });

    db.insert(auditLog).values({ tenantId, actorId: 'system', actorType: 'system', action: 'document_ingestion_completed', resource: 'document', resourceId: documentId, metadata: { chunkCount, mimeType }, traceId: '' }).catch(() => {});
    console.log(`[documentIngest] done: documentId=${documentId} chunks=${chunkCount}`);

  } catch (error) {
    // Mark as failed
    const message = error instanceof Error ? error.message : String(error);
    await db.execute(sql`
      UPDATE documents
      SET status = 'failed',
          error = ${message},
          updated_at = NOW()
      WHERE id = ${documentId} AND tenant_id = ${tenantId}
    `);
    db.insert(auditLog).values({ tenantId, actorId: 'system', actorType: 'system', action: 'document_ingestion_failed', resource: 'document', resourceId: documentId, metadata: { error: message, mimeType }, traceId: '' }).catch(() => {});
    console.error(`[documentIngest] failed: documentId=${documentId} error=${message}`);
    throw error; // re-throw so SQS retries
  }
}
