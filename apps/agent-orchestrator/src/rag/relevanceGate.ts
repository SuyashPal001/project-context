import { quickGeminiCall } from '../llm/quickCall.js';

export interface ScoredChunk {
  id: string;
  content: string;
  document_name: string;
  documentName?: string;
  score: number;
  relevanceScore?: number;
}

export function fastGateChunks(chunks: ScoredChunk[], scoreThreshold = 0.5, limit = 5): ScoredChunk[] {
  return chunks
    .sort((a, b) => b.score - a.score)
    .filter((c) => c.score >= scoreThreshold)
    .slice(0, limit)
    .map(c => ({ ...c, relevanceScore: 2 }))
}

export async function gateChunks(query: string, chunks: ScoredChunk[]): Promise<ScoredChunk[]> {
  if (chunks.length === 0) return [];

  const chunkList = chunks.map((c, i) =>
    `[${i + 1}] Source: ${c.document_name}\n${c.content.slice(0, 300)}`
  ).join('\n\n');

  const prompt = `You are a relevance filter. Score each chunk 0-3 for relevance to the query.

3 = Directly answers the query
2 = Useful background context
1 = Tangentially related
0 = Not relevant at all

Query: "${query}"

Chunks:
${chunkList}

Respond ONLY with chunk numbers and scores, one per line:
1: <score>
2: <score>`;

  const result = await quickGeminiCall(prompt);

  const scores = new Map<number, number>();
  result.split('\n').forEach((line: string) => {
    const match = line.match(/(\d+):\s*(\d)/);
    if (match) scores.set(parseInt(match[1]) - 1, parseInt(match[2]));
  });

  return chunks
    .map((chunk, i) => ({ ...chunk, relevanceScore: scores.get(i) ?? 0 }))
    .filter(c => (c.relevanceScore ?? 0) >= 2)
    .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));
}
