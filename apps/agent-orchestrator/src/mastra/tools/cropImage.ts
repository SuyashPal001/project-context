import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { uploadGeneratedFile } from '../../persistence.js'
import { fetchPresignedUrl } from './mediaCache.js'
import { persistCost } from '../cost.js'

// A closer framing of an existing image is a crop, not a generation: from a
// full-body still, a head-and-shoulders or waist-up view is the same pixels,
// so the face stays identical and it costs no credits. Never regenerate (or
// edit_image) just to get a closer shot. One small vision call finds the head;
// ffmpeg does the crop.

const execFile = promisify(execFileCb)
const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const VISION_MODEL = 'gemini-3.6-flash'
const TIMEOUT_MS = 30_000
const FFMPEG_TIMEOUT_MS = 30_000

export type CropFraming = 'close-up' | 'half-body'
/** Head bounding box as fractions of the image (0..1). */
export type HeadBox = { x: number; y: number; w: number; h: number }

// Crop height in head-heights, and how much of a head-height sits above the head.
const FRAMING: Record<CropFraming, { heads: number; above: number }> = {
  'close-up': { heads: 3.2, above: 0.45 },
  'half-body': { heads: 5.5, above: 0.6 },
}

/**
 * A 3:4 crop around the head, in whole pixels, clamped inside the image.
 * Exported for tests. Without a head box it falls back to the top-centre,
 * where a standing full-body subject's head almost always is.
 */
/**
 * keepAspect crop for a video start frame: a gentle zoom (not a tight crop)
 * that keeps the source's shape, centred on the face, with the whole head and
 * some shoulders inside. Returns null when there is no head box or the zoom
 * would cut the face — the caller then uses the source image unchanged, so a
 * clip never starts from a faceless frame.
 */
export function computeZoomRect(width: number, height: number, framing: CropFraming, head: HeadBox | null): { x: number; y: number; w: number; h: number } | null {
  if (!head) return null
  const zoom = framing === 'close-up' ? 1.5 : 1.25
  const w = Math.round(width / zoom), h = Math.round(height / zoom)
  const cx = (head.x + head.w / 2) * width
  const cy = (head.y + head.h / 2) * height
  // Face centre a little above the middle of the frame.
  const x = Math.round(Math.min(Math.max(cx - w / 2, 0), width - w))
  const y = Math.round(Math.min(Math.max(cy - h * 0.42, 0), height - h))
  const hx = head.x * width, hy = head.y * height, hw = head.w * width, hh = head.h * height
  if (hx < x || hy < y || hx + hw > x + w || hy + hh * 1.1 > y + h) return null
  return { x, y, w: w - (w % 2), h: h - (h % 2) }
}

export function computeCropRect(width: number, height: number, framing: CropFraming, head: HeadBox | null, aspect = 3 / 4): { x: number; y: number; w: number; h: number } {
  const box = head ?? { x: 0.4, y: 0.06, w: 0.2, h: 0.12 }
  const { heads, above } = FRAMING[framing]
  let cropH = Math.round(box.h * height * heads)
  let cropW = Math.round(cropH * aspect)
  if (cropW > width) { cropW = width; cropH = Math.round(cropW / aspect) }
  if (cropH > height) { cropH = height; cropW = Math.min(width, Math.round(cropH * aspect)) }
  const centreX = (box.x + box.w / 2) * width
  const top = box.y * height - box.h * height * above
  const x = Math.round(Math.min(Math.max(centreX - cropW / 2, 0), width - cropW))
  const y = Math.round(Math.min(Math.max(top, 0), height - cropH))
  // ffmpeg's yuv420 output wants even dimensions.
  return { x, y, w: cropW - (cropW % 2), h: cropH - (cropH % 2) }
}

/** Gemini's native detection format: box_2d = [ymin, xmin, ymax, xmax] on a
 *  0-1000 scale. gemini-3.6-flash answers this way even when asked for x/y/w/h
 *  (2026-10-03: every crop silently fell back to the top-centre guess, which
 *  cropped a seated presenter's cap instead of his face). */
function parseBox2d(raw: string): HeadBox | null {
  const m = /"box_2d"\s*:\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/.exec(raw)
  if (!m) return null
  const [ymin, xmin, ymax, xmax] = m.slice(1).map(Number)
  if ([ymin, xmin, ymax, xmax].some((n) => !Number.isFinite(n) || n < 0 || n > 1000) || ymax <= ymin || xmax <= xmin) return null
  return { x: xmin / 1000, y: ymin / 1000, w: (xmax - xmin) / 1000, h: (ymax - ymin) / 1000 }
}

/** Parses {"x":..,"y":..,"w":..,"h":..} (fractions) — or Gemini's box_2d — out of the model's reply; null when unusable. */
export function parseHeadBox(raw: string): HeadBox | null {
  const native = parseBox2d(raw)
  if (native) return native
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const v = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
    const nums = ['x', 'y', 'w', 'h'].map((k) => Number(v[k]))
    if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) return null
    const [x, y, w, h] = nums
    if (w <= 0.01 || h <= 0.01 || x + w > 1.001 || y + h > 1.001) return null
    return { x, y, w, h }
  } catch {
    return null
  }
}

async function findHead(base64: string, mimeType: string, tenantId: string | undefined, signal: AbortSignal): Promise<HeadBox | null> {
  try {
    const res = await fetch(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
      body: JSON.stringify({
        model: VISION_MODEL, temperature: 0, max_tokens: 120,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: 'text', text: 'Find the main person\'s (or character\'s) head, from the top of the hair to the chin. Return ONLY JSON {"x":..,"y":..,"w":..,"h":..} with the head\'s bounding box as fractions of the image width and height (0 to 1, x and y are the top-left corner).' },
        ] }],
      }),
    })
    if (!res.ok) return null
    const result = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
    if (tenantId && result.usage) {
      persistCost({ tenantId, agentId: 'crop-image', workflowId: 'media-understanding', model: VISION_MODEL, inputTokens: result.usage.prompt_tokens ?? 0, outputTokens: result.usage.completion_tokens ?? 0 })
    }
    return parseHeadBox(result.choices?.[0]?.message?.content ?? '')
  } catch {
    return null
  }
}

export const cropImage = createTool({
  id: 'crop-image',
  description: 'Free: makes a closer framing of an existing image by cropping it — "close-up" (head and shoulders) or "half-body" (waist up), 3:4 (or the source\'s own shape with keepAspect), around the person\'s head. The face stays pixel-identical and no credits are spent. Use it whenever a closer view of an image you already have is wanted — never generate or edit_image just to get a closer shot.',
  inputSchema: z.object({
    fileId: z.string().describe('The image to crop, e.g. a full-body still'),
    framing: z.enum(['close-up', 'half-body']).default('close-up'),
    title: z.string().max(120).optional().describe('File title, e.g. "Aroha — close-up"'),
    keepAspect: z.boolean().optional().describe('Keep the source image\'s shape and size (e.g. a 9:16 video still stays 9:16) instead of a 3:4 crop. Use it when the crop becomes a video clip\'s start frame.'),
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
    const { fileId, framing, title, keepAspect } = inputData as { fileId: string; framing: CropFraming; title?: string; keepAspect?: boolean }
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    if (!idToken) return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE' }
    if (!conversationId) return { refused: true, refusalReason: 'NO_SESSION_CONTEXT' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const workDir = mkdtempSync(join(tmpdir(), 'crop-image-'))
    try {
      const url = new URL(await fetchPresignedUrl(fileId, idToken, controller.signal))
      url.searchParams.delete('x-amz-checksum-mode')
      const imageRes = await fetch(url.toString(), { signal: controller.signal })
      if (!imageRes.ok) return { refused: true, refusalReason: 'SOURCE_IMAGE_UNAVAILABLE' }
      const mimeType = imageRes.headers.get('content-type') ?? 'image/png'
      const bytes = Buffer.from(await imageRes.arrayBuffer())
      const inputPath = join(workDir, 'in')
      writeFileSync(inputPath, bytes)

      const { stdout } = await execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', inputPath], { timeout: FFMPEG_TIMEOUT_MS })
      const [width, height] = stdout.trim().split('x').map(Number)
      if (!width || !height) return { refused: true, refusalReason: 'CROP_FAILED' }

      const head = await findHead(bytes.toString('base64'), mimeType, tenantId, controller.signal)
      // keepAspect (a video start frame): a face-centred zoom, or the source
      // itself when the face can't be placed safely — never a blind guess.
      const rect = keepAspect
        ? (computeZoomRect(width, height, framing, head) ?? { x: 0, y: 0, w: width - (width % 2), h: height - (height % 2) })
        : computeCropRect(width, height, framing, head)
      const outputPath = join(workDir, 'out.jpg')
      // keepAspect: scale the crop back up to the source size, so a 9:16 still
      // stays a full-size 9:16 start frame for generate_video.
      const scale = keepAspect ? `,scale=${width - (width % 2)}:${height - (height % 2)}:flags=lanczos` : ''
      await execFile('ffmpeg', ['-y', '-i', inputPath, '-vf', `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}${scale}`, '-q:v', '2', outputPath], { timeout: FFMPEG_TIMEOUT_MS })

      const attachment = await uploadGeneratedFile(idToken, {
        conversationId, title: title ?? (framing === 'close-up' ? 'Close-up' : 'Half-body'),
        content: readFileSync(outputPath), contentType: 'image/jpeg', extension: 'jpg',
      })
      if (!attachment) return { refused: true, refusalReason: 'STORAGE_FAILED' }
      return { fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size }
    } catch (err) {
      console.error('[cropImage] failed:', (err as Error).message)
      return { refused: true, refusalReason: 'CROP_FAILED' }
    } finally {
      clearTimeout(timer)
      rmSync(workDir, { recursive: true, force: true })
    }
  },
})
