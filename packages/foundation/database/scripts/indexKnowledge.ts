import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { globSync } from 'glob';
import postgres from 'postgres';
import * as dotenv from 'dotenv';

dotenv.config({ path: resolve(__dirname, '../../../../apps/api/.env') });

const REPO_ROOT = resolve(__dirname, '../../../..');
const DRY_RUN  = process.argv.includes('--dry-run');
const PROVIDER = 'vertex';
const MODEL    = 'text-embedding-004';
const MIN_LEN  = 50;
const BATCH    = 100;

// ── chunking helpers ──────────────────────────────────────────────────────────

function splitOn(content: string, pattern: RegExp): string[] {
  const re = new RegExp(pattern.source, 'gm');
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) positions.push(m.index);
  if (positions.length === 0) return [content];
  const bounds = [0, ...positions, content.length];
  return bounds
    .slice(0, -1)
    .map((start, i) => content.slice(start, bounds[i + 1]).trim())
    .filter(Boolean);
}

const chunkers: Record<string, (c: string) => string[]> = {
  migration: (c) => [c],
  route:     (c) => splitOn(c, /\w+\.(get|post|put|delete|patch)\(/),
  test:      (c) => splitOn(c, /describe\(/),
  claude_md: (c) => splitOn(c, /^## /m),
};

// ── file specs ────────────────────────────────────────────────────────────────

interface FileSpec { pattern: string; layer: string; fileType: string }

const SPECS: FileSpec[] = [
  { pattern: 'packages/foundation/database/migrations/*.sql', layer: 'data',     fileType: 'migration' },
  { pattern: 'apps/api/src/routes/**/*.ts',                   layer: 'platform', fileType: 'route'     },
  { pattern: 'apps/**/__tests__/**/*.ts',                     layer: 'platform', fileType: 'test'      },
  { pattern: 'apps/**/*.test.ts',                             layer: 'platform', fileType: 'test'      },
  { pattern: 'CLAUDE.md',                                     layer: 'system',   fileType: 'claude_md' },
];

interface Chunk {
  filePath: string; layer: string; fileType: string;
  content: string; chunkIndex: number; totalChunks: number;
}

function discoverChunks(): Chunk[] {
  const all: Chunk[] = [];
  const seen = new Set<string>(); // deduplicate test files matched by both globs

  for (const spec of SPECS) {
    const files = globSync(spec.pattern, { cwd: REPO_ROOT, absolute: true, ignore: ['**/node_modules/**', '**/dist/**'] });
    for (const abs of files) {
      const rel = abs.slice(REPO_ROOT.length + 1);
      if (seen.has(rel)) continue;
      seen.add(rel);

      const raw = readFileSync(abs, 'utf-8');
      const chunkFn = chunkers[spec.fileType] ?? ((c) => [c]);
      const chunks = chunkFn(raw).filter(c => c.length >= MIN_LEN);
      const total = chunks.length;

      chunks.forEach((content, i) =>
        all.push({ filePath: rel, layer: spec.layer, fileType: spec.fileType, content, chunkIndex: i, totalChunks: total })
      );
      console.log(`  [${spec.fileType}] ${rel} → ${total} chunk(s)`);
    }
  }
  return all;
}

// ── cache-aware batch embed ───────────────────────────────────────────────────

type WithEmbedding = Chunk & { embedding: number[] };

async function batchEmbed(sql: postgres.Sql, chunks: Chunk[]): Promise<WithEmbedding[]> {
  const hashes = chunks.map(c => createHash('sha256').update(c.content).digest('hex'));

  // Single query for all cached embeddings
  const cached = await sql<{ hash: string; embedding: string }[]>`
    SELECT hash, embedding::text
    FROM   embedding_cache
    WHERE  hash = ANY(${hashes})
      AND  provider = ${PROVIDER}
      AND  model    = ${MODEL}
  `;
  const cacheMap = new Map(cached.map(r => [r.hash, r.embedding]));

  // Identify misses
  const missIdx: number[]  = [];
  const missText: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (!cacheMap.has(hashes[i])) { missIdx.push(i); missText.push(chunks[i].content); }
  }

  // Embed misses (embedTexts internally batches at 100)
  let embedResults: Array<{ contentHash: string; embedding: number[] }> = [];
  if (missText.length > 0) {
    const { embedTexts } = await import('@serverless-saas/ai');
    embedResults = await embedTexts(missText, 'RETRIEVAL_DOCUMENT');
    // Persist new embeddings to cache
    for (const r of embedResults) {
      await sql`
        INSERT INTO embedding_cache (hash, provider, model, embedding)
        VALUES (${r.contentHash}, ${PROVIDER}, ${MODEL}, ${`[${r.embedding.join(',')}]`}::vector)
        ON CONFLICT (hash, provider, model) DO NOTHING
      `;
    }
  }

  console.log(`    ${cached.length} from cache, ${embedResults.length} newly embedded`);

  const embedMap = new Map(embedResults.map(r => [r.contentHash, r.embedding]));

  return chunks.map((chunk, i) => {
    const hash  = hashes[i];
    const embed = cacheMap.has(hash)
      ? cacheMap.get(hash)!.slice(1, -1).split(',').map(Number)
      : embedMap.get(hash)!;
    return { ...chunk, embedding: embed };
  });
}

// ── insert batch ──────────────────────────────────────────────────────────────

async function insertBatch(sql: postgres.Sql, rows: WithEmbedding[], tenantId: string): Promise<void> {
  for (const r of rows) {
    await sql`
      INSERT INTO knowledge_chunks
        (tenant_id, layer, file_type, file_path, task_id, event_type,
         content, embedding, chunk_index, total_chunks, indexed_at)
      VALUES (
        ${tenantId}, ${r.layer}, ${r.fileType}, ${r.filePath}, ${null},
        ${'initial_index'}, ${r.content},
        ${`[${r.embedding.join(',')}]`}::vector,
        ${r.chunkIndex}, ${r.totalChunks}, NOW()
      )
    `;
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const tenantId = process.env.SYSTEM_TENANT_ID;
  if (!tenantId) throw new Error('SYSTEM_TENANT_ID env var is required');

  if (DRY_RUN) console.log('[DRY RUN] — no DB writes\n');

  console.log('Discovering files...');
  const chunks = discoverChunks();
  console.log(`\nFound ${chunks.length} total chunks\n`);

  if (DRY_RUN) {
    const byType: Record<string, number> = {};
    for (const c of chunks) byType[c.fileType] = (byType[c.fileType] ?? 0) + 1;
    console.log('Chunks by type:');
    for (const [t, n] of Object.entries(byType)) console.log(`  ${t}: ${n}`);
    return;
  }

  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  let totalInserted = 0;

  try {
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      console.log(`\nBatch ${Math.floor(i / BATCH) + 1} (chunks ${i + 1}–${Math.min(i + BATCH, chunks.length)})`);

      const withEmbed = await batchEmbed(client, batch);
      await insertBatch(client, withEmbed, tenantId);

      totalInserted += batch.length;
    }
  } finally {
    await client.end();
  }

  console.log(`\nTotal: ${totalInserted} chunks indexed`);
}

main().catch(err => { console.error(err); process.exit(1); });
