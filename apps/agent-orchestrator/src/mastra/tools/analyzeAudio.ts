import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { fetchPresignedUrl, downloadToSessionCache } from './mediaCache.js'
import { persistCost } from '../cost.js'

const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
// Gemini's inlineData path caps total request size around ~20MB; base64 inflates
// raw bytes by ~4/3, so 15MB raw -> ~20MB base64'd, landing right at that ceiling
// with only JSON/prompt overhead to spare. Kept conservative (rather than pushed
// to the edge) so oversized files fail with the clear "file too large" error
// thrown by mediaCache.ts instead of an opaque gateway HTTP error.
const MAX_AUDIO_BYTES = 15 * 1024 * 1024
const QUICK_TIMEOUT_MS = 45_000
const DEEP_TIMEOUT_MS = 150_000

async function callGatewayForAudio(
  buf: Buffer,
  mimeType: string,
  mode: 'quick' | 'deep',
  signal: AbortSignal,
): Promise<{ text: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }> {
  const format = mimeType.split('/')[1] ?? 'mp3'
  const prompt = mode === 'quick'
    ? 'Give a brief 1-2 sentence summary of what is said in this audio.'
    : 'Transcribe this audio in full, as accurately as possible.'
  const response = await fetch(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    signal,
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

    const mode = inputData.mode ?? 'quick'
    const timeoutMs = mode === 'deep' ? DEEP_TIMEOUT_MS : QUICK_TIMEOUT_MS

    // One overall deadline for the whole pipeline (presign -> download ->
    // gateway call), not just the last leg — previously only the gateway
    // fetch was bounded, so a slow/hanging presign or S3 download could stall
    // this tool call well past the timeout the caller is told about.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const presignedUrl = await fetchPresignedUrl(inputData.fileId, idToken, controller.signal)
      // tenantId scopes the download cache across the whole conversation (and
      // beyond) rather than one turn — see the doc comment on sessionCache in
      // mediaCache.ts. Falls back to sessionId only if tenantId is unavailable.
      const { buf, mimeType } = await downloadToSessionCache(tenantId ?? sessionId, inputData.fileId, presignedUrl, MAX_AUDIO_BYTES, controller.signal)
      const { text, usage } = await callGatewayForAudio(buf, mimeType, mode, controller.signal)
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
        return { success: false, error: `analysis timed out (${mode} mode)`, partial: true }
      }
      return { success: false, error: message }
    } finally {
      clearTimeout(timer)
    }
  },
})
