import { sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { embedQuery } from './embeddings';

export interface RetrievedChunk {
  id: string;
  content: string;
  chunkIndex: number;
  metadata: Record<string, unknown>;
  documentName: string;
  documentId: string;
  score: number;
  source: 'document' | 'codebase';
}

interface DocRow {
  id: string;
  content: string;
  chunk_index: number;
  metadata: Record<string, unknown> | null;
  document_name: string;
  document_id: string;
  vector_score: number;
  text_score: number;
}

interface KnowledgeRow {
  id: string;
  content: string;
  chunk_index: number;
  file_path: string;
  layer: string;
  file_type: string;
  vector_score: number; // cosine distance — lower is better
  text_score: number;
}

function computeRrf(
  byVector: Array<{ id: string }>,
  byText: Array<{ id: string }>,
  k = 60
): Map<string, number> {
  const scores = new Map<string, number>();
  [byVector, byText].forEach(list => {
    list.forEach((row, index) => {
      scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (k + index + 1));
    });
  });
  return scores;
}

export async function retrieveChunks(
  query: string,
  tenantId: string,
  limit = 5,
  scoreThreshold = 0.5,
  personFolderId?: string
): Promise<RetrievedChunk[]> {
  const queryEmbedding = await embedQuery(query);
  const vectorStr = `[${queryEmbedding.join(',')}]`;

  // Run both table searches in parallel
  const [docResult, kResult] = await Promise.all([
    personFolderId
      // Person-folder-scoped query — no documents table JOIN needed
      ? db.execute(sql`
          SELECT
            dc.id,
            dc.content,
            dc.chunk_index,
            dc.metadata,
            COALESCE(dc.metadata->>'filename', 'document') AS document_name,
            dc.document_id,
            (1 - (dc.embedding <=> ${vectorStr}::vector))               AS vector_score,
            ts_rank(dc.tsv, websearch_to_tsquery('english', ${query}))  AS text_score
          FROM document_chunks dc
          WHERE dc.tenant_id = ${tenantId}
            AND dc.person_folder_id = ${personFolderId}
            AND (
              dc.embedding <=> ${vectorStr}::vector < 0.7
              OR dc.tsv @@ websearch_to_tsquery('english', ${query})
            )
          LIMIT 20
        `)
      : db.execute(sql`
          SELECT
            dc.id,
            dc.content,
            dc.chunk_index,
            dc.metadata,
            d.name AS document_name,
            d.id   AS document_id,
            (1 - (dc.embedding <=> ${vectorStr}::vector))               AS vector_score,
            ts_rank(dc.tsv, websearch_to_tsquery('english', ${query}))  AS text_score
          FROM document_chunks dc
          JOIN documents d ON d.id = dc.document_id
          WHERE dc.tenant_id = ${tenantId}
            AND d.status = 'ready'
            AND (
              dc.embedding <=> ${vectorStr}::vector < 0.7
              OR dc.tsv @@ websearch_to_tsquery('english', ${query})
            )
          LIMIT 20
        `),

    db.execute(sql`
      SELECT
        id,
        content,
        chunk_index,
        file_path,
        layer,
        file_type,
        embedding <=> ${vectorStr}::vector                              AS vector_score,
        ts_rank(tsv, websearch_to_tsquery('english', ${query}))         AS text_score
      FROM knowledge_chunks
      WHERE (tenant_id = ${tenantId} OR tenant_id IS NULL)
        AND invalidated_at IS NULL
        AND (
          embedding <=> ${vectorStr}::vector < 0.7
          OR tsv @@ websearch_to_tsquery('english', ${query})
        )
      ORDER BY vector_score ASC
      LIMIT 20
    `),
  ]);

  // drizzle-orm/postgres-js returns rows directly; neon-http wraps in { rows }
  const docRows = (((docResult as any).rows ?? docResult) as DocRow[]);
  const kRows = (((kResult as any).rows ?? kResult) as KnowledgeRow[]);

  if (docRows.length === 0 && kRows.length === 0) return [];

  // RRF on documents (vector_score = similarity — higher is better)
  const docRrf = computeRrf(
    [...docRows].sort((a, b) => b.vector_score - a.vector_score),
    [...docRows].sort((a, b) => b.text_score - a.text_score)
  );

  // RRF on knowledge (vector_score = distance — lower is better)
  const kRrf = computeRrf(
    [...kRows].sort((a, b) => a.vector_score - b.vector_score),
    [...kRows].sort((a, b) => b.text_score - a.text_score)
  );

  const docRowMap = new Map(docRows.map(r => [r.id, r]));
  const kRowMap   = new Map(kRows.map(r => [r.id, r]));

  // Merge both ranked lists, apply threshold, take top limit
  const merged = [
    ...Array.from(docRrf.entries()).map(([id, score]) => ({ id, score, source: 'document' as const })),
    ...Array.from(kRrf.entries()).map(([id, score])   => ({ id, score, source: 'codebase' as const })),
  ]
    .sort((a, b) => b.score - a.score)
    .filter(({ score }) => score >= scoreThreshold / 100)
    .slice(0, limit);

  return merged.map(({ id, score, source }) => {
    if (source === 'codebase') {
      const row = kRowMap.get(id)!;
      return {
        id,
        content: row.content,
        chunkIndex: row.chunk_index,
        metadata: { layer: row.layer, fileType: row.file_type },
        documentName: row.file_path,
        documentId: 'knowledge',
        score,
        source,
      };
    }
    const row = docRowMap.get(id)!;
    return {
      id,
      content: row.content,
      chunkIndex: row.chunk_index,
      metadata: row.metadata ?? {},
      documentName: row.document_name,
      documentId: row.document_id,
      score,
      source,
    };
  });
}
