import { sql } from 'drizzle-orm';
import { db } from '../db';
import { getOrEmbedTexts } from '@serverless-saas/ai';

// ── File classification ──────────────────────────────────────────────────────

const KNOWLEDGE_PATTERNS: RegExp[] = [
  /migrations\/.+\.sql$/,
  /routes\/.+\.ts$/,
  /__tests__\/.+\.ts$/,
  /\.test\.ts$/,
  /CLAUDE\.md$/,
];

export function matchesPattern(path: string): boolean {
  return KNOWLEDGE_PATTERNS.some((p) => p.test(path));
}

export function getLayer(path: string): string {
  if (path.endsWith('.sql') || path.includes('/migrations/')) return 'data';
  if (path.endsWith('CLAUDE.md')) return 'system';
  return 'platform';
}

export function getFileType(path: string): string {
  if (path.endsWith('.sql')) return 'migration';
  if (path.endsWith('CLAUDE.md')) return 'claude_md';
  if (path.includes('.test.') || path.includes('__tests__')) return 'test';
  if (path.includes('/routes/')) return 'route';
  return 'route';
}

// ── Chunking (mirrors packages/foundation/database/scripts/indexKnowledge.ts) ─

const MIN_LEN = 50;

function splitOn(content: string, pattern: RegExp): string[] {
  const re = new RegExp(pattern.source, 'gm');
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) positions.push(m.index);
  if (positions.length === 0) return [content];
  const bounds = [0, ...positions, content.length];
  return bounds.slice(0, -1).map((start, i) => content.slice(start, bounds[i + 1]).trim()).filter(Boolean);
}

export function chunkContent(content: string, fileType: string): string[] {
  let chunks: string[];
  if (fileType === 'migration') chunks = [content];
  else if (fileType === 'claude_md') chunks = splitOn(content, /^## /m);
  else if (fileType === 'route') chunks = splitOn(content, /\w+\.(get|post|put|delete|patch)\(/);
  else if (fileType === 'test') chunks = splitOn(content, /describe\(/);
  else chunks = [content];
  return chunks.filter((c) => c.length >= MIN_LEN);
}

// ── Index a single file (invalidate + embed + insert) ────────────────────────

export interface IndexFileArgs {
  tenantId: string;
  filePath: string;        // canonical path stored in knowledge_chunks.file_path
  content: string;
  fileType: string;
  layer: string;
  eventType: string;       // 'pr_merge' | 'initial_index'
}

export async function indexFile(args: IndexFileArgs): Promise<number> {
  const { tenantId, filePath, content, fileType, layer, eventType } = args;

  const chunks = chunkContent(content, fileType);
  if (chunks.length === 0) return 0;

  await db.execute(sql`
    UPDATE knowledge_chunks
    SET invalidated_at = NOW()
    WHERE file_path = ${filePath}
      AND tenant_id = ${tenantId}::uuid
      AND invalidated_at IS NULL
  `);

  const embedded = await getOrEmbedTexts(chunks, 'RETRIEVAL_DOCUMENT');

  for (let i = 0; i < embedded.length; i++) {
    const { text, embedding } = embedded[i];
    const vectorStr = `[${embedding.join(',')}]`;
    await db.execute(sql`
      INSERT INTO knowledge_chunks
        (tenant_id, layer, file_type, file_path, task_id, event_type,
         content, embedding, chunk_index, total_chunks, indexed_at)
      VALUES
        (${tenantId}::uuid, ${layer}, ${fileType}, ${filePath}, NULL, ${eventType},
         ${text}, ${vectorStr}::vector, ${i}, ${embedded.length}, NOW())
    `);
  }

  return embedded.length;
}
