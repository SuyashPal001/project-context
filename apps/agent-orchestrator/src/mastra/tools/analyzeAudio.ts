import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { fetchPresignedUrl, downloadToSessionCache } from './mediaCache.js'
import { persistCost } from '../cost.js'

const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const MAX_AUDIO_BYTES = 35 * 1024 * 1024
const QUICK_TIMEOUT_MS = 45_000
const DEEP_TIMEOUT_MS = 150_000

async function callGatewayForAudio(
  buf: Buffer,
  mimeType: string,
  mode: 'quick' | 'deep',
  timeoutMs: number,
): Promise<{ text: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const format = mimeType.split('/')[1] ?? 'mp3'
    const prompt = mode === 'quick'
      ? 'Give a brief 1-2 sentence summary of what is said in this audio.'
      : 'Transcribe this audio in full, as accurately as possible.'
    const response = await fetch(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
      body: JSON.stringify({
        model: 'gemini-2.5-flash',
        temperature: 0.1,
        max_tokens: mode === 'quick' ? 512 : 8192,
        messages: [{
          role: 'user',
          content: [
            { type: 'input_audio', input_audio: { data: buf.toString('base64'), format } },
            { type: 'text', text: prompt },
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

export const analyzeAudioTool = createTool({
  id: 'analyze_audio',
  description:
    'Understand the content of an attached audio file — transcribe or summarize speech. ' +
    'Use mode "quick" for a brief summary, "deep" for a full transcript.',
  inputSchema: z.object({
    fileId: z.string(),
    mode: z.enum(['quick', 'deep']).default('quick'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    transcript: z.string().optional(),
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
      const { buf, mimeType } = await downloadToSessionCache(sessionId, inputData.fileId, presignedUrl, MAX_AUDIO_BYTES)
      const timeoutMs = inputData.mode === 'deep' ? DEEP_TIMEOUT_MS : QUICK_TIMEOUT_MS
      const { text, usage } = await callGatewayForAudio(buf, mimeType, inputData.mode, timeoutMs)
      if (tenantId && usage) {
        persistCost({
          tenantId,
          agentId: 'analyze-audio',
          workflowId: 'media-understanding',
          model: 'gemini-2.5-flash',
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
        })
      }
      return { success: true, transcript: text }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.toLowerCase().includes('abort')) {
        return { success: false, error: `analysis timed out (${inputData.mode} mode)`, partial: true }
      }
      return { success: false, error: message }
    }
  },
})
