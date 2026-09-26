import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const { persistCost } = vi.hoisted(() => ({ persistCost: vi.fn() }))
vi.mock('../mastra/cost.js', () => ({ persistCost }))

import { productDescribeRouter, parseProductDescription } from './productDescribe.js'

const app = new Hono().route('', productDescribeRouter)
const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  process.env.INTERNAL_SERVICE_KEY = 'key-1'
})

const post = (body: unknown, key = 'key-1') => app.request('/internal/products/describe', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Service-Key': key },
  body: JSON.stringify(body),
})
const gateway = (content: string) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) })

describe('parseProductDescription', () => {
  it('parses plain, fenced, and prose-wrapped JSON', () => {
    expect(parseProductDescription('{"name":"Serum","description":"A bottle."}')).toEqual({ name: 'Serum', description: 'A bottle.' })
    expect(parseProductDescription('```json\n{"name":"Serum"}\n```')).toEqual({ name: 'Serum', description: null })
    expect(parseProductDescription('Here you go: {"name":"Serum","description":""} hope it helps')).toEqual({ name: 'Serum', description: null })
  })

  it('truncates an over-long name to 60 and description to 140 characters', () => {
    const out = parseProductDescription(JSON.stringify({ name: 'n'.repeat(80), description: 'd'.repeat(200) }))
    expect(out?.name).toHaveLength(60)
    expect(out?.description).toHaveLength(140)
  })

  it('returns null for no JSON, bad JSON, or a missing name', () => {
    expect(parseProductDescription('I cannot tell what this is.')).toBeNull()
    expect(parseProductDescription('{"name": ')).toBeNull()
    expect(parseProductDescription('{"description":"x"}')).toBeNull()
  })
})

describe('POST /internal/products/describe', () => {
  it('rejects a wrong service key before calling the model', async () => {
    const res = await post({ tenantId: 't1', imageBase64: 'QUJD', mimeType: 'image/png' }, 'wrong')
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a body without an image', async () => {
    const res = await post({ tenantId: 't1', mimeType: 'image/png' })
    expect(res.status).toBe(400)
  })

  it('sends the image to the gateway and returns the parsed name, logging cost', async () => {
    fetchMock.mockResolvedValue(gateway('{"name":"The Ordinary Niacinamide serum","description":"A white dropper bottle."}'))
    const res = await post({ tenantId: 't1', imageBase64: 'QUJD', mimeType: 'image/png' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: 'The Ordinary Niacinamide serum', description: 'A white dropper bottle.' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.model).toBe('gemini-3.6-flash')
    expect(body.messages[0].content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } })
    expect(persistCost).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', agentId: 'product-describe', model: 'gemini-3.6-flash' }))
  })

  it('returns 502 when the model output has no usable name', async () => {
    fetchMock.mockResolvedValue(gateway('no idea'))
    const res = await post({ tenantId: 't1', imageBase64: 'QUJD', mimeType: 'image/png' })
    expect(res.status).toBe(502)
  })

  it('returns 502 when the gateway errors', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    const res = await post({ tenantId: 't1', imageBase64: 'QUJD', mimeType: 'image/png' })
    expect(res.status).toBe(502)
  })
})
