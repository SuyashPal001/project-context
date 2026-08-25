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
  signal: AbortSignal,
): Promise<{ text: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }> {
  const prompt = mode === 'quick'
    ? 'Give a brief 1-2 sentence summary of what happens in this video, based on these sampled frames.'
    : 'Describe this video in detail — subjects, actions, and any notable scene changes across these sampled frames.'
  const response = await fetch(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    signal,
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

    const mode = inputData.mode ?? 'quick'
    const timeoutMs = mode === 'deep' ? DEEP_TIMEOUT_MS : QUICK_TIMEOUT_MS

    // One overall deadline for the whole pipeline (presign -> download ->
    // frame extraction -> gateway call), not just the last leg — previously
    // only the gateway fetch was bounded, and ffprobe/ffmpeg had no timeout
    // at all, so this tool call could hang well past the timeout the caller
    // is told about.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const presignedUrl = await fetchPresignedUrl(inputData.fileId, idToken, controller.signal)
      // tenantId scopes the download cache across the whole conversation (and
      // beyond) rather than one turn — see the doc comment on sessionCache in
      // mediaCache.ts. Falls back to sessionId only if tenantId is unavailable.
      const { filePath } = await downloadToSessionCache(tenantId ?? sessionId, inputData.fileId, presignedUrl, MAX_VIDEO_BYTES, controller.signal)
      const maxFrames = mode === 'deep' ? DEEP_FRAMES : QUICK_FRAMES
      const frames = await extractVideoFrames(filePath, inputData.fileId, sessionId, maxFrames, controller.signal)
      if (frames.length === 0) return { success: false, error: 'no frames could be extracted' }

      const { text, usage } = await callGatewayForFrames(frames, mode, controller.signal)
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
        return { success: false, error: `analysis timed out (${mode} mode)`, partial: true }
      }
      return { success: false, error: message }
    } finally {
      clearTimeout(timer)
    }
  },
})
