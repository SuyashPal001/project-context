import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { fetchPresignedUrl, downloadToSessionCache } from './mediaCache.js'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { askGeminiVideo } from './videoBreakdown/geminiVideo.js'

const execFile = promisify(execFileCb)
const MAX_VIDEO_BYTES = 200 * 1024 * 1024
const QUICK_TIMEOUT_MS = 90_000 // whole-video watch + a 480p analysis copy; 45s was sized for 8 frames
const DEEP_TIMEOUT_MS = 150_000

export const analyzeVideoTool = createTool({
  id: 'analyze_video',
  description:
    'Understand the content of an attached video file by watching and listening to the whole video, with rough timestamps. ' +
    'Use mode "quick" for a brief summary, "deep" for a detailed description with rough timestamp ranges per beat. ' +
    'Returns durationSeconds for callers (e.g. short-drama-stitch) that need the source clip\'s real length.',
  inputSchema: z.object({
    fileId: z.string(),
    mode: z.enum(['quick', 'deep']).default('quick'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    summary: z.string().optional(),
    frameCount: z.number().optional(),
    durationSeconds: z.number().optional(),
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
      // Whole video plus audio, not sampled frames (spec §4: frames were half-blind and cost more).
      const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { timeout: 30_000, signal: controller.signal })
      const durationSeconds = Math.round(parseFloat(stdout.trim()) * 100) / 100
      const prompt = mode === 'quick'
        ? 'Watch and listen to this whole video. Give a brief 1-2 sentence summary of what happens.'
        : 'Watch and listen to this whole video. Describe it in detail — subjects, actions, sound, on-screen text and scene changes — with a rough timestamp range for every beat (e.g. "0.0s-3.2s: ...").'
      const { raw } = await askGeminiVideo({ video: { filePath }, durationS: durationSeconds, prompt, tenantId, agentId: 'analyze-video', signal: controller.signal })
      return { success: true, summary: raw, durationSeconds }
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
