import { Hono } from 'hono'
import { isInternalServiceKey } from '../service-key.js'
import { persistCost } from '../mastra/cost.js'

const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const MODEL = 'gemini-3.6-flash' // same model analyzeImage.ts uses
const GATEWAY_TIMEOUT_MS = 15_000
const MAX_NAME = 60
const MAX_DESCRIPTION = 140

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

export const productDescribeRouter = new Hono()

productDescribeRouter.post('/internal/products/describe', async (c) => {
  if (!isInternalServiceKey(c.req.header('X-Service-Key'))) return c.json({ error: 'Unauthorized' }, 401)

  let body: { tenantId?: unknown; imageBase64?: unknown; mimeType?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  const { tenantId, imageBase64, mimeType } = body
  if (typeof tenantId !== 'string' || typeof imageBase64 !== 'string' || !imageBase64 || typeof mimeType !== 'string' || !mimeType.startsWith('image/')) {
    return c.json({ error: 'tenantId, imageBase64 and an image mimeType are required' }, 400)
  }

  try {
    const response = await fetch(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1,
        max_tokens: 200,
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
