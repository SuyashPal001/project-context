import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import {
  generateVideoItem, videoItemSchema, videoOutputSchema, VIDEO_MODEL, type VideoItemInput,
} from './generateVideo.js'
import { shouldRequireApproval } from './generationApproval.js'
import { MAX_BATCH_ITEMS, runBatch, type MediaExecContext } from './batchRunner.js'

export const generateVideos = createTool({
  id: 'generate-videos',
  description: `Generates up to ${MAX_BATCH_ITEMS} short video clips in parallel in ONE call, one item per clip, each with the same fields as generate_video. Use only for clips that are independent of each other (each depends at most on an anchor that already exists). Costs one approval card for the whole batch. Returns a per-item results list; a failed item is refunded and reported without failing the others.`,
  inputSchema: z.object({ items: z.array(videoItemSchema).min(1).max(MAX_BATCH_ITEMS) }),
  outputSchema: z.object({
    results: z.array(videoOutputSchema.extend({ index: z.number() })),
    succeeded: z.number(),
    failed: z.number(),
  }),
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'video_generation', subject: VIDEO_MODEL }, ctx),
  execute: async (inputData, execContext) => {
    const { items } = inputData as { items: VideoItemInput[] }
    return runBatch(items, (item, index) =>
      generateVideoItem(item, execContext as unknown as MediaExecContext, index))
  },
})
