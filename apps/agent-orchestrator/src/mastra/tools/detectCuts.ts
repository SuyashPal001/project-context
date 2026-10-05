import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { fetchPresignedUrl, downloadToSessionCache } from './mediaCache.js'

// Free: the real cut times of a reference ad (ffmpeg scene detection), so a
// recreation follows its edit rhythm instead of guessed timings (spec P6).
const execFile = promisify(execFileCb)
const MAX_SOURCE_BYTES = 300 * 1024 * 1024

export function parseShowinfoCuts(stderr: string): number[] {
  return [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Math.round(Number(m[1]) * 100) / 100).filter((n) => n > 0)
}

export const detectCuts = createTool({
  id: 'detect-cuts',
  description: 'Free: finds the real cut times (scene changes) in a reference video, for recreating its edit timing. Write the result into the TVC plan as brief.reference.cutTimes.',
  inputSchema: z.object({
    videoFileId: z.string().describe('The reference video'),
    threshold: z.number().min(0.05).max(0.9).default(0.25).describe('Scene-change sensitivity; 0.25 matched the 2026-10-05 reference ad'),
  }),
  outputSchema: z.object({
    cutTimes: z.array(z.number()).optional(),
    durationSeconds: z.number().optional(),
    refused: z.boolean().optional(),
    refusalReason: z.string().optional(),
  }),
  execute: async (inputData, execContext) => {
    const { videoFileId, threshold } = inputData as { videoFileId: string; threshold: number }
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined ?? 'unknown'
    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE' }
    try {
      const url = await fetchPresignedUrl(videoFileId, idToken)
      const { filePath } = await downloadToSessionCache(tenantId || conversationId, videoFileId, url, MAX_SOURCE_BYTES)
      const { stderr } = await execFile('ffmpeg', ['-hide_banner', '-i', filePath, '-filter:v', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'], { timeout: 180_000, maxBuffer: 32 * 1024 * 1024 })
      const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { timeout: 30_000 })
      return { cutTimes: parseShowinfoCuts(stderr), durationSeconds: Math.round(parseFloat(stdout.trim()) * 100) / 100 }
    } catch (err) {
      console.error('[detectCuts] failed:', (err as Error).message)
      return { refused: true, refusalReason: 'DETECT_CUTS_FAILED' }
    }
  },
})
