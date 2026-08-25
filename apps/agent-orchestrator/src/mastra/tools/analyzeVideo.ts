import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { fetchPresignedUrl, downloadToSessionCache } from './mediaCache.js'
import { extractVideoFrames } from '../../media.js'
import { persistCost } from '../cost.js'

const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const MAX_VIDEO_BYTES = 200 * 1024 * 1024
const QUICK_FRAMES = 8
const DEEP_FRAMES = 20
const QUICK_TIMEOUT_MS = 45_000
const DEEP_TIMEOUT_MS = 150_000

async function callGatewayForFrames(
  frames: Array<{ base64: string; mimeType: string }>,
  mode: 'quick' | 'deep',
  timeoutMs: number,
): Promise<{ text: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const prompt = mode === 'quick'
      ? 'Give a brief 1-2 sentence summary of what happens in this video, based on these sampled frames.'
      : 'Describe this video in detail — subjects, actions, and any notable scene changes across these sampled frames.'
    const response = await fetch(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
      body: JSON.stringify({
        model: 'gemini-2.5-flash',
        temperature: 0.1,
        max_tokens: mode === 'quick' ? 512 : 4096,
        messages: [{
          role: 'user',
          content: [
            ...frames.map(f => ({ type: 'image_url' as const, image_url: { url: f.base64 } })),
            { type: 'text' as const, text: prompt },
          ],
        }],
      }),
    })
    if (!response.ok) throw new Error(`gateway HTTP ${response.status}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await response.json() as any
    return { text: result?.choices?.[0]?.message?.content ?? '', usage: result?.usage }
  } finally {
    clearTimeout(timer)
  }
}

export const analyzeVideoTool = createTool({
  id: 'analyze_video',
  description:
    'Understand the content of an attached video file by sampling frames. ' +
    'Use mode "quick" for a brief summary, "deep" for a detailed description.',
  inputSchema: z.object({
    fileId: z.string(),
    mode: z.enum(['quick', 'deep']).default('quick'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    summary: z.string().optional(),
    frameCount: z.number().optional(),
    partial: z.boolean().optional(),
    error: z.string().optional(),
  }),
  execute: async (inputData, execContext) => {
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined
    const sessionId = execContext?.requestContext?.get('sessionId') as string | undefined
    if (!idToken || !sessionId) return { success: false, error: 'no_active_session' }

    try {
      const presignedUrl = await fetchPresignedUrl(inputData.fileId, idToken)
      const { filePath } = await downloadToSessionCache(sessionId, inputData.fileId, presignedUrl, MAX_VIDEO_BYTES)
      const maxFrames = inputData.mode === 'deep' ? DEEP_FRAMES : QUICK_FRAMES
      const frames = await extractVideoFrames(filePath, inputData.fileId, sessionId, maxFrames)
      if (frames.length === 0) return { success: false, error: 'no frames could be extracted' }

      const timeoutMs = inputData.mode === 'deep' ? DEEP_TIMEOUT_MS : QUICK_TIMEOUT_MS
      const { text, usage } = await callGatewayForFrames(frames, inputData.mode, timeoutMs)
      if (tenantId && usage) {
        persistCost({
          tenantId,
          agentId: 'analyze-video',
          workflowId: 'media-understanding',
          model: 'gemini-2.5-flash',
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
        })
      }
      return { success: true, summary: text, frameCount: frames.length }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.toLowerCase().includes('abort')) {
        return { success: false, error: `analysis timed out (${inputData.mode} mode)`, partial: true }
      }
      return { success: false, error: message }
    }
  },
})
