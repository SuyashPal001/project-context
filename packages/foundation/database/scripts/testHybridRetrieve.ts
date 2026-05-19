/**
 * Smoke-test for the updated retrieveChunks() logic.
 * Bypasses embedQuery() (needs GCP_SA_KEY) and uses the metadata server
 * directly — same credential path as indexKnowledge.ts.
 */
import { resolve } from 'node:path';
import postgres from 'postgres';
import * as dotenv from 'dotenv';

dotenv.config({ path: resolve(__dirname, '../../../../apps/api/.env') });

const GCP_META  = 'http://metadata.google.internal/computeMetadata/v1';
const MODEL     = 'text-embedding-004';
const TENANT_ID = '299463df-c836-479b-8b33-30e0527dcb42';
const QUERY     = 'tenant isolation pattern';
const LIMIT     = 5;
const SCORE_THRESHOLD = 0.5;
const K         = 60;

async function getToken(): Promise<string> {
  const r = await fetch(`${GCP_META}/instance/service-accounts/default/token`, { headers: { 'Metadata-Flavor': 'Google' } });
  return ((await r.json()) as { access_token: string }).access_token;
}

async function getProjectId(): Promise<string> {
  return (await fetch(`${GCP_META}/project/project-id`, { headers: { 'Metadata-Flavor': 'Google' } })).text();
}

async function embedQuery(text: string, token: string, projectId: string): Promise<number[]> {
  const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/${MODEL}:predict`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ content: text, task_type: 'RETRIEVAL_QUERY' }] }),
  });
  if (!res.ok) throw new Error(`Embed failed: ${await res.text()}`);
  const d = await res.json() as { predictions: Array<{ embeddings: { values: number[] } }> };
  return d.predictions[0].embeddings.values;
}

function computeRrf(byVector: Array<{ id: string }>, byText: Array<{ id: string }>): Map<string, number> {
  const scores = new Map<string, number>();
  [byVector, byText].forEach(list => {
    list.forEach((row, i) => {
      scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (K + i + 1));
    });
  });
  return scores;
}

async function main() {
  const [token, projectId] = await Promise.all([getToken(), getProjectId()]);
  const vec = await embedQuery(QUERY, token, projectId);
  const vecStr = `[${vec.join(',')}]`;

  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

  const [docRows, kRows] = await Promise.all([
    sql<Array<{ id: string; content: string; chunk_index: number; metadata: unknown; document_name: string; document_id: string; vector_score: number; text_score: number }>>`
      SELECT dc.id, dc.content, dc.chunk_index, dc.metadata,
             d.name AS document_name, d.id AS document_id,
             (1 - (dc.embedding <=> ${vecStr}::vector))              AS vector_score,
             ts_rank(dc.tsv, websearch_to_tsquery('english', ${QUERY})) AS text_score
      FROM document_chunks dc
      JOIN documents d ON d.id = dc.document_id
      WHERE dc.tenant_id = ${TENANT_ID}
        AND d.status = 'ready'
        AND (dc.embedding <=> ${vecStr}::vector < 0.7
             OR dc.tsv @@ websearch_to_tsquery('english', ${QUERY}))
      LIMIT 20`,

    sql<Array<{ id: string; content: string; chunk_index: number; file_path: string; layer: string; file_type: string; vector_score: number; text_score: number }>>`
      SELECT id, content, chunk_index, file_path, layer, file_type,
             embedding <=> ${vecStr}::vector                              AS vector_score,
             ts_rank(tsv, websearch_to_tsquery('english', ${QUERY}))      AS text_score
      FROM knowledge_chunks
      WHERE tenant_id = ${TENANT_ID}
        AND invalidated_at IS NULL
        AND (embedding <=> ${vecStr}::vector < 0.7
             OR tsv @@ websearch_to_tsquery('english', ${QUERY}))
      ORDER BY vector_score ASC
      LIMIT 20`,
  ]);

  await sql.end();

  console.log(`\ndoc_chunks fetched: ${docRows.length}   knowledge_chunks fetched: ${kRows.length}`);

  const docRrf = computeRrf(
    [...docRows].sort((a, b) => b.vector_score - a.vector_score),
    [...docRows].sort((a, b) => b.text_score - a.text_score)
  );
  const kRrf = computeRrf(
    [...kRows].sort((a, b) => a.vector_score - b.vector_score),
    [...kRows].sort((a, b) => b.text_score - a.text_score)
  );

  const docMap = new Map(docRows.map(r => [r.id, r]));
  const kMap   = new Map(kRows.map(r => [r.id, r]));

  const merged = [
    ...Array.from(docRrf.entries()).map(([id, score]) => ({ id, score, source: 'document' })),
    ...Array.from(kRrf.entries()).map(([id, score])   => ({ id, score, source: 'codebase' })),
  ]
    .sort((a, b) => b.score - a.score)
    .filter(({ score }) => score >= SCORE_THRESHOLD / 100)
    .slice(0, LIMIT);

  console.log(`\nQuery: "${QUERY}"`);
  console.log(`Top ${LIMIT} results after RRF merge + threshold=${SCORE_THRESHOLD}:\n`);

  merged.forEach(({ id, score, source }, i) => {
    if (source === 'codebase') {
      const r = kMap.get(id)!;
      const snippet = r.content.replace(/\s+/g, ' ').trim().slice(0, 200);
      console.log(`[${i + 1}] source=codebase  rrf=${score.toFixed(5)}`);
      console.log(`    file: ${r.file_path}  (${r.file_type} / ${r.layer})`);
      console.log(`    ${snippet}…\n`);
    } else {
      const r = docMap.get(id)!;
      const snippet = r.content.replace(/\s+/g, ' ').trim().slice(0, 200);
      console.log(`[${i + 1}] source=document  rrf=${score.toFixed(5)}`);
      console.log(`    doc: ${r.document_name}`);
      console.log(`    ${snippet}…\n`);
    }
  });
}

main().catch(err => { console.error(err); process.exit(1); });
