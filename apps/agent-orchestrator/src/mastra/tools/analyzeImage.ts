import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { fetchPresignedUrl } from './mediaCache.js'
import { persistCost } from '../cost.js'

const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const TIMEOUT_MS = 30_000

export const analyzeImageTool = createTool({
  id: 'analyze_image',
  description: 'Ask a specific yes/no or descriptive question about an image already attached to the conversation — e.g. verifying rendered text/wordmarks are spelled correctly.',
  inputSchema: z.object({
    fileId: z.string(),
    question: z.string().describe('The specific question to ask about the image, e.g. "Does this image spell ACME correctly? Answer yes or give the exact text as rendered."'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    answer: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (inputData, execContext) => {
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = execContext?.requestContext?.get('sessionId') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined
    if (!idToken || !sessionId) return { success: false, error: 'no_active_session' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const presignedUrl = await fetchPresignedUrl(inputData.fileId, idToken, controller.signal)
      const url = new URL(presignedUrl)
      url.searchParams.delete('x-amz-checksum-mode')
      const imageRes = await fetch(url.toString(), { signal: controller.signal })
      if (!imageRes.ok) return { success: false, error: `failed to fetch image: ${imageRes.status}` }
      const mimeType = imageRes.headers.get('content-type') ?? 'image/png'
      const base64 = Buffer.from(await imageRes.arrayBuffer()).toString('base64')

      const response = await fetch(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({
          model: 'gemini-3.6-flash',
          temperature: 0.1,
          max_tokens: 256,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
              { type: 'text', text: inputData.question },
            ],
          }],
        }),
      })
      if (!response.ok) return { success: false, error: `gateway HTTP ${response.status}` }
      const result = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      const answer = result.choices?.[0]?.message?.content
      if (!answer) return { success: false, error: 'no answer returned' }
      // Cost tracking — matches analyzeVideo.ts's persistCost call. Without
      // this, every wordmark check is untracked LLM spend.
      if (tenantId && result.usage) {
        persistCost({
          tenantId,
          agentId: 'analyze-image',
          workflowId: 'media-understanding',
          model: 'gemini-3.6-flash',
          inputTokens: result.usage.prompt_tokens ?? 0,
          outputTokens: result.usage.completion_tokens ?? 0,
        })
      }
      return { success: true, answer }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.toLowerCase().includes('abort')) return { success: false, error: 'analysis timed out' }
      return { success: false, error: message }
    } finally {
      clearTimeout(timer)
    }
  },
})
