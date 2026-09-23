import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import {
  generateImageItem, imageItemSchema, imageOutputSchema, IMAGE_MODEL, type ImageItemInput,
} from './generateImage.js'
import { shouldRequireApproval } from './generationApproval.js'
import { MAX_BATCH_ITEMS, runBatch, type MediaExecContext } from './batchRunner.js'

export const generateImages = createTool({
  id: 'generate-images',
  description: `Generates up to ${MAX_BATCH_ITEMS} images in parallel in ONE call, one item per image, each with the same fields as generate_image. Use only for images that are independent of each other (each depends at most on an anchor that already exists, such as a cast sheet). Costs one approval card for the whole batch. Returns a per-item results list; a failed item is reported without failing the others.`,
  inputSchema: z.object({ items: z.array(imageItemSchema).min(1).max(MAX_BATCH_ITEMS) }),
  outputSchema: z.object({
    results: z.array(imageOutputSchema.extend({ index: z.number() })),
    succeeded: z.number(),
    failed: z.number(),
  }),
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'image_generation', subject: IMAGE_MODEL }, ctx),
  execute: async (inputData, execContext) => {
    const { items } = inputData as { items: ImageItemInput[] }
    return runBatch(items, (item, index) =>
      generateImageItem(item, execContext as unknown as MediaExecContext, index))
  },
})
