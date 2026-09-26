import { Hono } from 'hono'
import { isInternalServiceKey } from '../service-key.js'
import { persistCost } from '../mastra/cost.js'

const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const MODEL = 'gemini-3.6-flash' // same model analyzeImage.ts uses
const GATEWAY_TIMEOUT_MS = 15_000
const MAX_NAME = 60
const MAX_DESCRIPTION = 140
// With the 15 s gateway call this stays inside the API's 20 s wait for this route.
const IMAGE_TIMEOUT_MS = 5_000
const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // matches the API's MAX_NAMING_IMAGE_BYTES

const PROMPT = `You are naming a product photo for a creative library.
Return ONLY a JSON object: {"name": string, "description": string}.
- name: at most 60 characters. If a brand or product name is readable on the item or its packaging, use it (e.g. "The Ordinary Niacinamide 10% + Zinc 1%"). Otherwise a short plain description of the item (e.g. "Light blue compression t-shirt").
- description: one sentence, at most 140 characters, describing only what is visible. No claims, benefits, prices or marketing words.
- If the photo is not a product (a room, a person, a landscape), still name what it shows.`

export function parseProductDescription(raw: string): { name: string; description: string | null } | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let value: unknown
  try {
    value = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as { name?: unknown; description?: unknown }
  const name = typeof record.name === 'string' ? record.name.trim().slice(0, MAX_NAME).trim() : ''
  if (!name) return null
  const description = typeof record.description === 'string' ? record.description.trim().slice(0, MAX_DESCRIPTION).trim() : ''
  return { name, description: description || null }
}

/** Fetches a presigned image link; null on a failed download or an image over the cap. */
async function downloadImageBase64(imageUrl: string): Promise<string | null> {
  const url = new URL(imageUrl)
  // Same fix as analyzeImage.ts: the checksum-mode param breaks presigned GETs.
  url.searchParams.delete('x-amz-checksum-mode')
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) })
  if (!res.ok) return null
  if (Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) return null
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > MAX_IMAGE_BYTES) return null
  return bytes.toString('base64')
}

export const productDescribeRouter = new Hono()

productDescribeRouter.post('/internal/products/describe', async (c) => {
  if (!isInternalServiceKey(c.req.header('X-Service-Key'))) return c.json({ error: 'Unauthorized' }, 401)

  let body: { tenantId?: unknown; imageUrl?: unknown; imageBase64?: unknown; mimeType?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  const { tenantId, imageUrl, mimeType } = body
  const hasUrl = typeof imageUrl === 'string' && imageUrl.startsWith('https://')
  const hasInline = typeof body.imageBase64 === 'string' && body.imageBase64 !== ''
  if (typeof tenantId !== 'string' || (!hasUrl && !hasInline) || typeof mimeType !== 'string' || !mimeType.startsWith('image/')) {
    return c.json({ error: 'tenantId, an https imageUrl (or imageBase64) and an image mimeType are required' }, 400)
  }

  try {
    // The API sends a presigned link, not the bytes: base64 in the request body
    // hit the VM proxy's body limit (413) for ordinary 1-2 MB product photos.
    // imageBase64 is still accepted so an API deployed before this change keeps working.
    const imageBase64 = hasUrl ? await downloadImageBase64(imageUrl as string) : body.imageBase64 as string
    if (!imageBase64) {
      console.error(`[productDescribe] image download failed or over ${MAX_IMAGE_BYTES} bytes tenantId=${tenantId}`)
      return c.json({ error: 'Naming failed' }, 502)
    }

    const response = await fetch(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1,
        // Gemini 3.x thinking tokens count against maxOutputTokens and the gateway
        // sets no separate thinking budget, so a low cap can consume the whole
        // budget on thinking and leave nothing for the JSON output. Output length
        // is still bounded below by MAX_NAME/MAX_DESCRIPTION truncation.
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
    })
    if (!response.ok) {
      console.error(`[productDescribe] gateway HTTP ${response.status} tenantId=${tenantId}`)
      return c.json({ error: 'Naming failed' }, 502)
    }
    const result = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    if (result.usage) {
      // Not charged to the tenant (spec) — logged so the cost stays visible.
      persistCost({
        tenantId, agentId: 'product-describe', workflowId: 'creative-products', model: MODEL,
        inputTokens: result.usage.prompt_tokens ?? 0, outputTokens: result.usage.completion_tokens ?? 0,
      })
    }
    const parsed = parseProductDescription(result.choices?.[0]?.message?.content ?? '')
    if (!parsed) {
      console.warn(`[productDescribe] unusable model output tenantId=${tenantId}`)
      return c.json({ error: 'Naming failed' }, 502)
    }
    return c.json(parsed)
  } catch (error) {
    console.error(`[productDescribe] failed tenantId=${tenantId}:`, (error as Error).message)
    return c.json({ error: 'Naming failed' }, 502)
  }
})
