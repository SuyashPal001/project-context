import { Hono, type Context } from 'hono'
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

const MAX_AVATAR_NAME = 24
const MAX_AVATAR_LABEL = 32

// Mirrors the platform presets' shape ("Mira" / "Everyday creator" / "Casual").
const AVATAR_PROMPT = `You are naming a presenter photo for a creative library of ad avatars.
Return ONLY a JSON object: {"name": string, "role": string, "tone": string}.
- name: one friendly first name for the presenter (e.g. "Mira", "Arjun"). Never a real person's name, even if you recognise them. For a mascot or animal, a short character name.
- role: 2-3 words for the kind of creator they look like, from visible cues only (setting, clothes, props), e.g. "Fitness creator", "Tech presenter", "Home cook".
- tone: one word for the delivery style the photo suggests, e.g. "Casual", "Warm", "Energetic", "Polished".
- Do not describe ethnicity, age, body or appearance in any field.`

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

export function parseAvatarDescription(raw: string): { name: string; role: string | null; tone: string | null } | null {
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
  const record = value as { name?: unknown; role?: unknown; tone?: unknown }
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max).trim() : '')
  const name = text(record.name, MAX_AVATAR_NAME)
  if (!name) return null
  return { name, role: text(record.role, MAX_AVATAR_LABEL) || null, tone: text(record.tone, MAX_AVATAR_LABEL) || null }
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

type DescribeBody = { tenantId: string; imageBase64: string; mimeType: string }

/** Validates the request and resolves the image. Returns a response to send, or the inputs. */
async function readDescribeBody(c: Context, logTag: string): Promise<Response | DescribeBody> {
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

  // The API sends a presigned link, not the bytes: base64 in the request body
  // hit the VM proxy's body limit (413) for ordinary 1-2 MB product photos.
  // imageBase64 is still accepted so an API deployed before this change keeps working.
  const imageBase64 = hasUrl ? await downloadImageBase64(imageUrl as string) : body.imageBase64 as string
  if (!imageBase64) {
    console.error(`[${logTag}] image download failed or over ${MAX_IMAGE_BYTES} bytes tenantId=${tenantId}`)
    return c.json({ error: 'Naming failed' }, 502)
  }
  return { tenantId, imageBase64, mimeType }
}

/** One vision call through the gateway. Returns the model's text, or null on a gateway error. */
async function describeImage(input: DescribeBody & { prompt: string; agentId: string; workflowId: string; logTag: string }): Promise<string | null> {
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
      // is still bounded below by the parsers' truncation.
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${input.mimeType};base64,${input.imageBase64}` } },
          { type: 'text', text: input.prompt },
        ],
      }],
    }),
  })
  if (!response.ok) {
    console.error(`[${input.logTag}] gateway HTTP ${response.status} tenantId=${input.tenantId}`)
    return null
  }
  const result = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  if (result.usage) {
    // Not charged to the tenant (spec) — logged so the cost stays visible.
    persistCost({
      tenantId: input.tenantId, agentId: input.agentId, workflowId: input.workflowId, model: MODEL,
      inputTokens: result.usage.prompt_tokens ?? 0, outputTokens: result.usage.completion_tokens ?? 0,
    })
  }
  return result.choices?.[0]?.message?.content ?? ''
}

export const productDescribeRouter = new Hono()

productDescribeRouter.post('/internal/products/describe', async (c) => {
  const input = await readDescribeBody(c, 'productDescribe')
  if (input instanceof Response) return input
  try {
    const raw = await describeImage({ ...input, prompt: PROMPT, agentId: 'product-describe', workflowId: 'creative-products', logTag: 'productDescribe' })
    if (raw === null) return c.json({ error: 'Naming failed' }, 502)
    const parsed = parseProductDescription(raw)
    if (!parsed) {
      console.warn(`[productDescribe] unusable model output tenantId=${input.tenantId}`)
      return c.json({ error: 'Naming failed' }, 502)
    }
    return c.json(parsed)
  } catch (error) {
    console.error(`[productDescribe] failed tenantId=${input.tenantId}:`, (error as Error).message)
    return c.json({ error: 'Naming failed' }, 502)
  }
})

productDescribeRouter.post('/internal/avatars/describe', async (c) => {
  const input = await readDescribeBody(c, 'avatarDescribe')
  if (input instanceof Response) return input
  try {
    const raw = await describeImage({ ...input, prompt: AVATAR_PROMPT, agentId: 'avatar-describe', workflowId: 'creative-avatars', logTag: 'avatarDescribe' })
    if (raw === null) return c.json({ error: 'Naming failed' }, 502)
    const parsed = parseAvatarDescription(raw)
    if (!parsed) {
      console.warn(`[avatarDescribe] unusable model output tenantId=${input.tenantId}`)
      return c.json({ error: 'Naming failed' }, 502)
    }
    return c.json(parsed)
  } catch (error) {
    console.error(`[avatarDescribe] failed tenantId=${input.tenantId}:`, (error as Error).message)
    return c.json({ error: 'Naming failed' }, 502)
  }
})
