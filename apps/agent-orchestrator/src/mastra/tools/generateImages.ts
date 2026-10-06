import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import {
  generateImageItem, imageItemSchema, imageOutputSchema, type ImageItemInput,
} from './generateImage.js'
import { shouldRequireApproval } from './generationApproval.js'
import { MAX_BATCH_ITEMS, runBatch, batchProgressEmitter, type MediaExecContext } from './batchRunner.js'
import { emitGenerationStarted } from './generationStarted.js'
import { firstShotUnreviewed, firstShotRefusal } from './reviewGate.js'
import { imageEngineFor, imageModelFor, type ImageEngine } from './imageEngine.js'

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
    !firstShotUnreviewed(ctx?.requestContext, 'still', (_input as { items?: unknown[] }).items?.length ?? 0) && shouldRequireApproval({ resourceType: 'image_generation', subject: imageModelFor(imageEngineFor((ctx as { requestContext?: never })?.requestContext, (_input as { items?: Array<{ engine?: ImageEngine }> }).items?.[0]?.engine), (_input as { items?: Array<{ imageSize?: string }> }).items?.[0]?.imageSize).rateSubject }, ctx),
  execute: async (inputData, execContext) => {
    const { items } = inputData as { items: ImageItemInput[] }
    if (firstShotUnreviewed(execContext?.requestContext, 'still', items.length)) return { ...firstShotRefusal('still'), results: [], succeeded: 0, failed: 0 }
    emitGenerationStarted(execContext, { aspectRatio: (inputData as { items?: Array<{ aspectRatio?: unknown }> }).items?.[0]?.aspectRatio, count: items.length })
    const sendEvent = execContext?.requestContext?.get('sendEvent') as ((event: string, data: object) => void) | undefined
    const toolCallId = (execContext as unknown as MediaExecContext)?.agent?.toolCallId
    return runBatch(
      items,
      (item, index) => generateImageItem(item, execContext as unknown as MediaExecContext, index),
      batchProgressEmitter(sendEvent, toolCallId),
    )
  },
})
