import { sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';

export async function getCachedEmbedding(
  contentHash: string,
  provider = 'vertex',
  model = 'text-embedding-004'
): Promise<number[] | null> {
  const result = await db.execute(sql`
    SELECT embedding FROM embedding_cache
    WHERE hash = ${contentHash}
      AND provider = ${provider}
      AND model = ${model}
  `);
  const rows = (result as any).rows ?? (result as any);
  if (!rows || rows.length === 0) return null;
  const raw = rows[0].embedding;
  if (typeof raw === 'string') {
    return raw.slice(1, -1).split(',').map(Number);
  }
  return raw as number[];
}

export async function setCachedEmbedding(
  contentHash: string,
  embedding: number[],
  provider = 'vertex',
  model = 'text-embedding-004'
): Promise<void> {
  const vectorStr = `[${embedding.join(',')}]`;
  await db.execute(sql`
    INSERT INTO embedding_cache (hash, provider, model, embedding)
    VALUES (${contentHash}, ${provider}, ${model}, ${vectorStr}::vector)
    ON CONFLICT (hash, provider, model) DO NOTHING
  `);
}

export async function getOrEmbedTexts(
  texts: string[],
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'
): Promise<Array<{ text: string; contentHash: string; embedding: number[] }>> {
  const { embedTexts } = await import('./embeddings');
  const crypto = await import('crypto');

  const results: Array<{ text: string; contentHash: string; embedding: number[] }> = [];
  const uncached: Array<{ text: string; contentHash: string; index: number }> = [];

  // Check cache for each text
  for (let i = 0; i < texts.length; i++) {
    const contentHash = crypto.createHash('sha256').update(texts[i]).digest('hex');
    const cached = await getCachedEmbedding(contentHash);
    if (cached) {
      results[i] = { text: texts[i], contentHash, embedding: cached };
    } else {
      uncached.push({ text: texts[i], contentHash, index: i });
    }
  }

  // Embed uncached in batch
  if (uncached.length > 0) {
    const embedResults = await embedTexts(uncached.map(u => u.text), taskType);
    for (let i = 0; i < uncached.length; i++) {
      const { contentHash, index } = uncached[i];
      const embedding = embedResults[i].embedding;
      results[index] = { text: uncached[i].text, contentHash, embedding };
      // Store in cache (fire and forget — don't block on this)
      setCachedEmbedding(contentHash, embedding).catch(console.error);
    }
  }

  return results;
}
