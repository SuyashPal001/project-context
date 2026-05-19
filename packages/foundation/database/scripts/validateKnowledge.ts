import { resolve } from 'node:path';
import postgres from 'postgres';
import * as dotenv from 'dotenv';

dotenv.config({ path: resolve(__dirname, '../../../../apps/api/.env') });

const MODEL       = 'text-embedding-004';
const TENANT_ID   = '299463df-c836-479b-8b33-30e0527dcb42';
const GCP_META    = 'http://metadata.google.internal/computeMetadata/v1';

async function getToken(): Promise<string> {
  const res = await fetch(`${GCP_META}/instance/service-accounts/default/token`, {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  const d = await res.json() as { access_token: string };
  return d.access_token;
}

async function embedQuery(text: string, token: string, projectId: string): Promise<number[]> {
  const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/${MODEL}:predict`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ content: text }] }),
  });
  if (!res.ok) throw new Error(`Embed failed (${res.status}): ${await res.text()}`);
  const d = await res.json() as { predictions: Array<{ embeddings: { values: number[] } }> };
  return d.predictions[0].embeddings.values;
}

const QUERIES = [
  'tenant isolation pattern',
  'what tables exist for plans and milestones',
  'API error handling',
  'soft delete pattern',
  'how does authentication work',
];

async function main() {
  const token     = await getToken();
  const projectId = await (await fetch(`${GCP_META}/project/project-id`, { headers: { 'Metadata-Flavor': 'Google' } })).text();
  const sql       = postgres(process.env.DATABASE_URL!, { max: 1 });

  try {
    for (const query of QUERIES) {
      console.log(`\n${'═'.repeat(70)}`);
      console.log(`Query: "${query}"`);
      console.log('─'.repeat(70));

      const vec = await embedQuery(query, token, projectId);
      const vecStr = `[${vec.join(',')}]`;

      const rows = await sql<{
        id: string; file_path: string; layer: string; file_type: string;
        content: string; vector_dist: number; text_rank: number;
      }[]>`
        SELECT id, file_path, layer, file_type, content,
               (embedding <=> ${vecStr}::vector)  AS vector_dist,
               ts_rank(tsv, plainto_tsquery('english', ${query})) AS text_rank
        FROM   knowledge_chunks
        WHERE  tenant_id     = ${TENANT_ID}
          AND  invalidated_at IS NULL
        ORDER  BY vector_dist ASC
        LIMIT  3
      `;

      rows.forEach((r, i) => {
        const snippet = r.content.replace(/\s+/g, ' ').trim().slice(0, 200);
        console.log(`\n  [${i + 1}] ${r.file_path}  (${r.file_type} / ${r.layer})`);
        console.log(`      vec_dist=${Number(r.vector_dist).toFixed(4)}  text_rank=${Number(r.text_rank).toFixed(4)}`);
        console.log(`      ${snippet}${r.content.length > 200 ? '…' : ''}`);
      });
    }
  } finally {
    await sql.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
