import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { uploadGeneratedFile } from '../../persistence.js'
import { fetchPresignedUrl } from './mediaCache.js'

// The default way to chain talking-head clips: clip N+1 starts from the real
// last frame of clip N, so the face, pose, outfit, room and light carry over
// and the cut is nearly invisible (A/B-tested 2026-10-03 against a crop and a
// sheet-based new still; all kept the face, only this one had no jump at the
// cut). Free: local ffmpeg, no model call.
const execFile = promisify(execFileCb)
const TIMEOUT_MS = 60_000

/** ffmpeg arguments to grab one frame: the very last one, the first one, or at a time. */
export function frameArgs(input: string, output: string, at: 'last' | 'first' | number): string[] {
  const seek = at === 'last' ? ['-sseof', '-0.1'] : at === 'first' ? [] : ['-ss', String(Math.max(0, at))]
  return ['-y', ...seek, '-i', input, '-frames:v', '1', '-q:v', '2', output]
}

export const extractFrame = createTool({
  id: 'extract-frame',
  description: 'Free: saves one frame of a video as an image — by default its LAST frame. Use it to chain talking-head clips: the next clip\'s start frame is the previous clip\'s last frame, so the same face, pose, outfit and room carry straight on. Also for a thumbnail or a still from a specific moment.',
  inputSchema: z.object({
    videoFileId: z.string().describe('The video to take the frame from'),
    at: z.union([z.literal('last'), z.literal('first'), z.number().min(0)]).default('last').describe('"last" (default), "first", or a time in seconds'),
    title: z.string().max(120).optional().describe('File title, e.g. "Clip 1 — last frame"'),
  }),
  outputSchema: z.object({
    fileId: z.string().optional(),
    name: z.string().optional(),
    fileType: z.string().optional(),
    size: z.number().optional(),
    refused: z.boolean().optional(),
    refusalReason: z.string().optional(),
  }),
  execute: async (inputData, execContext) => {
    const { videoFileId, at, title } = inputData as { videoFileId: string; at: 'last' | 'first' | number; title?: string }
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE' }
    if (!conversationId) return { refused: true, refusalReason: 'NO_SESSION_CONTEXT' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const workDir = mkdtempSync(join(tmpdir(), 'extract-frame-'))
    try {
      const url = new URL(await fetchPresignedUrl(videoFileId, idToken, controller.signal))
      url.searchParams.delete('x-amz-checksum-mode')
      const videoRes = await fetch(url.toString(), { signal: controller.signal })
      if (!videoRes.ok) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE' }
      const inputPath = join(workDir, 'in.mp4')
      writeFileSync(inputPath, Buffer.from(await videoRes.arrayBuffer()))
      const outputPath = join(workDir, 'frame.jpg')
      await execFile('ffmpeg', frameArgs(inputPath, outputPath, at ?? 'last'), { timeout: TIMEOUT_MS })
      const attachment = await uploadGeneratedFile(idToken, {
        conversationId, title: title ?? 'Last frame',
        content: readFileSync(outputPath), contentType: 'image/jpeg', extension: 'jpg',
      })
      if (!attachment) return { refused: true, refusalReason: 'STORAGE_FAILED' }
      return { fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size }
    } catch (err) {
      console.error('[extractFrame] failed:', (err as Error).message)
      return { refused: true, refusalReason: 'EXTRACT_FAILED' }
    } finally {
      clearTimeout(timer)
      rmSync(workDir, { recursive: true, force: true })
    }
  },
})
