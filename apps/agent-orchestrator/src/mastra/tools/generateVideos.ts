import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import {
  generateVideoItem, videoItemSchema, videoOutputSchema, VIDEO_MODEL, type VideoItemInput,
} from './generateVideo.js'
import { shouldRequireApproval } from './generationApproval.js'
import { markVideoMade, videoBlockedThisTurn, SHOW_FIRST_REFUSAL } from './oneVideoPerTurn.js'
import { MAX_BATCH_ITEMS, runBatch, batchProgressEmitter, type MediaExecContext } from './batchRunner.js'
import { emitGenerationStarted } from './generationStarted.js'
import { firstShotUnreviewed, firstShotRefusal } from './reviewGate.js'

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
    !videoBlockedThisTurn(ctx?.requestContext) && !firstShotUnreviewed(ctx?.requestContext, 'clip', (_input as { items?: unknown[] }).items?.length ?? 0) && shouldRequireApproval({ resourceType: 'video_generation', subject: VIDEO_MODEL }, ctx),
  execute: async (inputData, execContext) => {
    if (videoBlockedThisTurn(execContext?.requestContext)) return { ...SHOW_FIRST_REFUSAL, results: [], succeeded: 0, failed: 0 }
    const { items } = inputData as { items: VideoItemInput[] }
    if (firstShotUnreviewed(execContext?.requestContext, 'clip', items.length)) return { ...firstShotRefusal('clip'), results: [], succeeded: 0, failed: 0 }
    emitGenerationStarted(execContext, { aspectRatio: (inputData as { items?: Array<{ aspectRatio?: unknown }> }).items?.[0]?.aspectRatio, count: items.length })
    const sendEvent = execContext?.requestContext?.get('sendEvent') as ((event: string, data: object) => void) | undefined
    const toolCallId = (execContext as unknown as MediaExecContext)?.agent?.toolCallId
    const batch = await runBatch(
      items,
      (item, index) => generateVideoItem(item, execContext as unknown as MediaExecContext, index),
      batchProgressEmitter(sendEvent, toolCallId),
    )
    if (batch.succeeded > 0) markVideoMade(execContext?.requestContext, (execContext as unknown as { agent?: { messages?: unknown } })?.agent?.messages)
    return batch
  },
})
