import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const CHUNK_SIZE = 1000;
const OVERLAP = 200;

export function chunkEmbed(text: string): { chunkCount: number } {
  if (!text || text.trim().length === 0) return { chunkCount: 0 }
  if (text.length <= CHUNK_SIZE) return { chunkCount: 1 }
  let count = 0
  let i = 0
  while (i < text.length) {
    count++
    i += CHUNK_SIZE - OVERLAP
  }
  return { chunkCount: count }
}

export const chunkEmbedTool = createTool({
  id: 'chunk-embed',
  description: 'Chunks text content for downstream embedding. Returns chunk count.',
  inputSchema: z.object({
    text: z.string(),
  }),
  outputSchema: z.object({
    chunkCount: z.number(),
  }),
  execute: async ({ context }) => {
    return chunkEmbed(context.text)
  },
});
