import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { fetchPresignedUrl, downloadToSessionCache } from './mediaCache.js'
import { refundRenderGraphicsCharge } from './renderGraphicsCredits.js'
import { shouldRequireApproval } from './generationApproval.js'
import { stableToolCallId } from '../../credits.js'
import { finishedAdTitle } from './fileTitle.js'

const execFile = promisify(execFileCb)

const RENDER_SUBJECT = 'ffmpeg-render-graphics'
const RENDER_TIMEOUT_MS = 180_000
const FFMPEG_TIMEOUT_MS = 60_000
const MAX_SOURCE_BYTES = 500 * 1024 * 1024

// presenter-video's own standalone Remotion project (see its package.json
// for why it's npm, not pnpm — same reasoning as root mcp-server/). Must be
// `npm install`-ed on the VM before this tool can run; that's a one-time
// deploy step, not something this tool does at request time.
// 3 levels up from src/mastra/tools/ (or the mirrored dist/mastra/tools/)
// reaches apps/agent-orchestrator/ — verified against tsconfig's
// outDir:"dist"/rootDir:"src", which mirrors src/'s structure exactly, so
// this path is correct whether running from src or dist.
const GRAPHICS_RENDERER_DIR = fileURLToPath(new URL('../../../graphics-renderer', import.meta.url))

const graphicsElementSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('title_card'), startSeconds: z.number().min(0), endSeconds: z.number().positive(),
    kicker: z.string().optional(), name: z.string(), role: z.string().optional(),
  }),
  z.object({
    type: z.literal('info_cards'), startSeconds: z.number().min(0), endSeconds: z.number().positive(),
    headline: z.string(), cards: z.array(z.object({ label: z.string(), value: z.string() })).min(1).max(4),
  }),
  z.object({
    type: z.literal('follow_card'), startSeconds: z.number().min(0), endSeconds: z.number().positive(),
    handle: z.string(), site: z.string().optional(),
  }),
  z.object({
    type: z.literal('captions'), startSeconds: z.number().min(0), endSeconds: z.number().positive(),
    text: z.string(), keyword: z.string().optional(),
  }),
  z.object({
    type: z.literal('corner_mark'), startSeconds: z.number().min(0), endSeconds: z.number().positive(),
    text: z.string().optional(),
  }),
  z.object({
    type: z.literal('screen_walkthrough'), startSeconds: z.number().min(0), endSeconds: z.number().positive(),
    screenshotFileId: z.string().describe('A capture_webpage output fileId.'),
    urlText: z.string().optional(),
    zoomTo: z.number().min(1).max(1.4).optional().describe('Hard-clamped to 1.4 inside the renderer regardless of what is passed — zooming further cuts real content (verified by hand).'),
    cursor: z.object({ xPct: z.number().min(0).max(100), yPct: z.number().min(0).max(100) }).optional(),
  }),
  z.object({
    type: z.literal('compare'), startSeconds: z.number().min(0), endSeconds: z.number().positive(),
    left: z.object({ label: z.string(), value: z.string() }), right: z.object({ label: z.string(), value: z.string() }),
  }),
]).refine((v) => v.endSeconds > v.startSeconds, { message: 'INVALID_ELEMENT_RANGE: endSeconds must be greater than startSeconds' })

export const inputSchema = z.object({
  videoFileId: z.string().describe('The presenter cut to overlay graphics onto (already has voice/lips, before music). Graphics are applied before mix_music_bed.'),
  aspectRatio: z.enum(['16:9', '9:16']),
  elements: z.array(graphicsElementSchema).min(1).max(20),
})

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  jobId: z.string().optional(),
})

async function probeVideo(path: string): Promise<{ fps: number; duration: number }> {
  const { stdout } = await execFile('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,duration', '-of', 'json', path,
  ], { timeout: FFMPEG_TIMEOUT_MS })
  const probe = JSON.parse(stdout) as { streams?: Array<{ r_frame_rate?: string; duration?: string }> }
  const v = probe.streams?.[0]
  const [n, d] = (v?.r_frame_rate ?? '30/1').split('/').map(Number)
  const fps = d ? n / d : n
  return { fps: Number.isFinite(fps) && fps > 0 ? fps : 30, duration: parseFloat(v?.duration ?? '0') }
}

export const renderGraphics = createTool({
  id: 'render-graphics',
  description: 'Overlays graphic beats (title cards, info cards, captions, a screen walkthrough, a compare card, a follow card, a corner mark) onto a presenter video. Remotion renders a transparent PNG sequence; ffmpeg overlays it onto the base video. Apply BEFORE mix_music_bed.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: RENDER_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { videoFileId, aspectRatio, elements } = inputData as z.infer<typeof inputSchema>

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${stableToolCallId(toolCallId)}`

    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }

    const scopeId = tenantId || sessionId
    let videoPath: string
    const screenshotPaths: Record<string, string> = {}
    try {
      const presignedUrl = await fetchPresignedUrl(videoFileId, idToken)
      videoPath = (await downloadToSessionCache(scopeId, videoFileId, presignedUrl, MAX_SOURCE_BYTES)).filePath
      for (const el of elements) {
        if (el.type !== 'screen_walkthrough') continue
        const shotUrl = await fetchPresignedUrl(el.screenshotFileId, idToken)
        screenshotPaths[el.screenshotFileId] = (await downloadToSessionCache(scopeId, el.screenshotFileId, shotUrl, MAX_SOURCE_BYTES)).filePath
      }
    } catch (err) {
      console.error(`[session:${sessionId}] renderGraphics: failed to download sources:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    const attempt = 0
    const chargeKey = `render-graphics:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('clip_assembly', RENDER_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED RENDER GRAPHICS: no active clip_assembly/${RENDER_SUBJECT} rate tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({
            tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'clip_assembly',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true, jobId }
          throw err
        }
      }
    }

    let workDir: string
    try {
      workDir = mkdtempSync(join(tmpdir(), 'render-graphics-'))
    } catch (err) {
      console.error(`[session:${sessionId}] renderGraphics: failed to create temp dir:`, (err as Error).message)
      if (charged) await refundRenderGraphicsCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'RENDER_FAILED', jobId }
    }

    const framesDir = join(workDir, 'frames')
    const outputPath = join(workDir, 'graphics.mp4')
    try {
      const { fps, duration } = await probeVideo(videoPath)
      if (!(duration > 0)) throw new Error(`ffprobe returned an invalid duration for the base video: ${duration}`)

      // Element props carry local screenshot file:// paths, not fileIds —
      // Remotion's <Img> loads screenshotUrl directly, and this process
      // already has the files on disk from the download step above.
      const remotionElements = elements.map((el) => {
        if (el.type !== 'screen_walkthrough') return el
        const { screenshotFileId, ...rest } = el
        return { ...rest, screenshotUrl: `file://${screenshotPaths[screenshotFileId]}` }
      })
      const propsPath = join(workDir, 'props.json')
      writeFileSync(propsPath, JSON.stringify({ aspectRatio, durationSeconds: duration, fps, elements: remotionElements }))

      await execFile('npx', [
        'remotion', 'render', 'src/index.ts', 'GraphicsOverlay', framesDir,
        `--props=${propsPath}`, '--sequence', '--image-format=png', '--log=error',
      ], { cwd: GRAPHICS_RENDERER_DIR, timeout: RENDER_TIMEOUT_MS })

      // Remotion's --sequence output pads the frame index to exactly the
      // digit count the LAST frame needs (e.g. 90 frames -> element-00.png
      // .. element-89.png, 2 digits; 300 frames -> element-000.png ..
      // element-299.png, 3 digits) — never a fixed width. Computing it from
      // the same frame count Remotion used, rather than hardcoding %02d,
      // is required or ffmpeg silently reads zero frames past 99.
      const totalFrames = Math.max(1, Math.round(duration * fps))
      const padding = Math.max(2, String(totalFrames - 1).length)
      const framePattern = join(framesDir, `element-%0${padding}d.png`)

      await execFile('ffmpeg', [
        '-y', '-i', videoPath, '-framerate', String(fps), '-i', framePattern,
        '-filter_complex', '[0:v][1:v]overlay=format=auto[outv]',
        '-map', '[outv]', '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'copy', '-shortest',
        outputPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
    } catch (err) {
      console.error(`[session:${sessionId}] renderGraphics: render/overlay failed:`, (err as Error).message)
      if (charged) await refundRenderGraphicsCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'RENDER_FAILED', jobId }
    }

    if (!conversationId) {
      if (charged) await refundRenderGraphicsCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    let buffer: Buffer
    try {
      buffer = readFileSync(outputPath)
    } catch (err) {
      console.error(`[session:${sessionId}] renderGraphics: failed to read output:`, (err as Error).message)
      if (charged) await refundRenderGraphicsCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'RENDER_FAILED', jobId }
    }
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: finishedAdTitle(conversationId, 'Graphics Pass'), content: buffer,
      contentType: 'video/mp4', extension: 'mp4',
    })
    rmSync(workDir, { recursive: true, force: true })

    if (!attachment) {
      if (charged) await refundRenderGraphicsCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})
