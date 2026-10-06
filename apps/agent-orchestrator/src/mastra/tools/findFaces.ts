import { persistCost } from '../cost.js'

// One face finder for every tool that needs to know where people are
// (spec 2026-10-05-tvc-jingle-design.md K2). crop_image takes the largest
// head; overlay_text and composite_end_card keep text off all of them. It
// asks for Gemini's native box_2d detection: gemini-3.6-flash answers that
// way even when asked for x/y/w/h (2026-10-03: every crop silently fell back
// to a top-centre guess until box_2d was parsed).
const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
export const FACE_MODEL = 'gemini-3.6-flash'
export const FIND_FACES_QUESTION = 'Detect the head of every person (or character) in this image, from the top of the hair to the chin. Reply ONLY with a JSON array, one entry per head: [{"box_2d":[ymin,xmin,ymax,xmax],"label":"head"}], coordinates on a 0-1000 scale. Reply [] if there is no one.'

/** A box as fractions of the image (0..1); x and y are the top-left corner. */
export type HeadBox = { x: number; y: number; w: number; h: number }
export class FaceFinderError extends Error {}

const BOX_2D_RE = /"box_2d"\s*:\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/g

/** Every valid box_2d ([ymin, xmin, ymax, xmax] on 0-1000) in the reply, in order. */
export function parseBox2dList(raw: string): HeadBox[] {
  const out: HeadBox[] = []
  for (const m of raw.matchAll(BOX_2D_RE)) {
    const [ymin, xmin, ymax, xmax] = m.slice(1).map(Number)
    if ([ymin, xmin, ymax, xmax].some((n) => !Number.isFinite(n) || n < 0 || n > 1000) || ymax <= ymin || xmax <= xmin) continue
    out.push({ x: xmin / 1000, y: ymin / 1000, w: (xmax - xmin) / 1000, h: (ymax - ymin) / 1000 })
  }
  return out
}

/** {"x":..,"y":..,"w":..,"h":..} as fractions (crop_image's original format); null when unusable. */
export function parseFractionBox(raw: string): HeadBox | null {
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

export function largestBox(boxes: HeadBox[]): HeadBox | null {
  return boxes.reduce<HeadBox | null>((best, b) => (!best || b.w * b.h > best.w * best.h ? b : best), null)
}

export async function findFaces(
  image: { data: string; mime: string },
  opts: { tenantId?: string; agentId: string; signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<HeadBox[]> {
  const res = await (opts.fetchImpl ?? fetch)(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST', signal: opts.signal,
    headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
    body: JSON.stringify({
      model: FACE_MODEL, temperature: 0, max_tokens: 600,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.data}` } },
        { type: 'text', text: FIND_FACES_QUESTION },
      ] }],
    }),
  })
  if (!res.ok) throw new FaceFinderError(`face finder: gateway ${res.status}`)
  const json = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
  if (opts.tenantId && json.usage) {
    persistCost({ tenantId: opts.tenantId, agentId: opts.agentId, workflowId: 'media-understanding', model: FACE_MODEL, inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 })
  }
  const content = json.choices?.[0]?.message?.content ?? ''
  const boxes = parseBox2dList(content)
  if (boxes.length) return boxes
  const single = parseFractionBox(content)
  if (single) return [single]
  if (/\[\s*\]/.test(content)) return []
  throw new FaceFinderError('face finder: unreadable reply')
}
