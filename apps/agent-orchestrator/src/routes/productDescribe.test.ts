import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const { persistCost } = vi.hoisted(() => ({ persistCost: vi.fn() }))
vi.mock('../mastra/cost.js', () => ({ persistCost }))

import { productDescribeRouter, parseProductDescription, parseAvatarDescription, avatarPrompt } from './productDescribe.js'

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

  // The API sends a presigned link instead of the bytes: base64 in the body hit
  // the VM proxy's body limit (413) for ordinary 1-2 MB product photos.
  describe('imageUrl', () => {
    const image = (bytes: Uint8Array, contentType = 'image/png', ok = true) => ({
      ok, status: ok ? 200 : 403,
      headers: new Headers({ 'content-type': contentType, 'content-length': String(bytes.length) }),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    })

    it('downloads the image from the link and sends it to the gateway as base64', async () => {
      fetchMock
        .mockResolvedValueOnce(image(new Uint8Array([65, 66, 67])))
        .mockResolvedValueOnce(gateway('{"name":"Light blue compression t-shirt"}'))
      const res = await post({ tenantId: 't1', imageUrl: 'https://bucket.s3.amazonaws.com/k?X-Amz-Signature=s&x-amz-checksum-mode=ENABLED', mimeType: 'image/png' })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ name: 'Light blue compression t-shirt', description: null })
      // Same fix as analyzeImage.ts: the checksum-mode param breaks presigned GETs.
      expect(fetchMock.mock.calls[0][0]).toBe('https://bucket.s3.amazonaws.com/k?X-Amz-Signature=s')
      const body = JSON.parse(fetchMock.mock.calls[1][1].body)
      expect(body.messages[0].content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } })
    })

    it('rejects a non-https link without fetching it', async () => {
      const res = await post({ tenantId: 't1', imageUrl: 'http://169.254.169.254/latest', mimeType: 'image/png' })
      expect(res.status).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('returns 502 when the image download fails', async () => {
      fetchMock.mockResolvedValueOnce(image(new Uint8Array([1]), 'image/png', false))
      const res = await post({ tenantId: 't1', imageUrl: 'https://bucket.s3.amazonaws.com/k', mimeType: 'image/png' })
      expect(res.status).toBe(502)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('returns 502 for an image over 10 MB without calling the gateway', async () => {
      fetchMock.mockResolvedValueOnce(image(new Uint8Array(10 * 1024 * 1024 + 1)))
      const res = await post({ tenantId: 't1', imageUrl: 'https://bucket.s3.amazonaws.com/k', mimeType: 'image/png' })
      expect(res.status).toBe(502)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })
})

describe('parseAvatarDescription', () => {
  it('parses name, role and tone, nulling empty labels', () => {
    expect(parseAvatarDescription('{"name":"Riya","role":"Fitness creator","tone":"Energetic"}')).toEqual({ name: 'Riya', role: 'Fitness creator', tone: 'Energetic' })
    expect(parseAvatarDescription('```json\n{"name":"Riya","role":""}\n```')).toEqual({ name: 'Riya', role: null, tone: null })
  })

  it('truncates an over-long name to 24 and labels to 32 characters', () => {
    const out = parseAvatarDescription(JSON.stringify({ name: 'n'.repeat(40), role: 'r'.repeat(50), tone: 't'.repeat(50) }))
    expect(out?.name).toHaveLength(24)
    expect(out?.role).toHaveLength(32)
    expect(out?.tone).toHaveLength(32)
  })

  it('returns null without a name', () => {
    expect(parseAvatarDescription('{"role":"Chef"}')).toBeNull()
    expect(parseAvatarDescription('nothing')).toBeNull()
  })
})

describe('POST /internal/avatars/describe', () => {
  const postAvatar = (body: unknown, key = 'key-1') => app.request('/internal/avatars/describe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Key': key },
    body: JSON.stringify(body),
  })

  it('rejects a wrong service key before calling the model', async () => {
    const res = await postAvatar({ tenantId: 't1', imageBase64: 'QUJD', mimeType: 'image/png' }, 'wrong')
    expect(res.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns the parsed avatar and logs cost under its own agent id', async () => {
    fetchMock.mockResolvedValue(gateway('{"name":"Riya","role":"Fitness creator","tone":"Energetic"}'))
    const res = await postAvatar({ tenantId: 't1', imageBase64: 'QUJD', mimeType: 'image/jpeg' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: 'Riya', role: 'Fitness creator', tone: 'Energetic' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].content[1].text).toContain('presenter photo')
    expect(persistCost).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'avatar-describe', workflowId: 'creative-avatars' }))
  })

  it('returns 502 on unusable output', async () => {
    fetchMock.mockResolvedValue(gateway('{"role":"Chef"}'))
    const res = await postAvatar({ tenantId: 't1', imageBase64: 'QUJD', mimeType: 'image/jpeg' })
    expect(res.status).toBe(502)
  })
})

describe('avatarPrompt', () => {
  it('steers the role by category so a TVC actor is not named a creator', () => {
    expect(avatarPrompt('TVC')).toMatch(/TVC lead actress/)
    expect(avatarPrompt('Animation')).toMatch(/Game hero/)
    expect(avatarPrompt('UGC')).not.toMatch(/TVC lead/)
    expect(avatarPrompt(undefined)).toBe(avatarPrompt('UGC'))
  })
})
