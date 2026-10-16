import { describe, it, expect, vi, beforeEach } from 'vitest'

const generate = vi.fn()
vi.mock('../agents/brandFillAgent.js', async (orig) => ({
  ...(await orig<typeof import('../agents/brandFillAgent.js')>()),
  brandFillAgent: { generate: (...a: unknown[]) => generate(...a) },
}))
const fetchInstagramProfile = vi.fn()
vi.mock('../brand/tikhub.js', () => ({ fetchInstagramProfile: (...a: unknown[]) => fetchInstagramProfile(...a) }))
const downloadImageBase64 = vi.fn()
vi.mock('../../routes/productDescribe.js', () => ({ downloadImageBase64: (...a: unknown[]) => downloadImageBase64(...a) }))
vi.mock('../cost.js', () => ({ persistCost: vi.fn() }))
const fetchMock = vi.fn()

const T = '11111111-1111-4111-8111-111111111111'
// A valid PNG magic-byte prefix, base64-encoded, so sniffImageMimeType recognises it as
// image/png — the fill step only attaches an image when the bytes actually sniff as one
// of the three accepted types.
const PNG_BASE64 = 'iVBORw0KGgoAAAAAAAAAAA=='
const facts = {
  url: 'https://mamaearth.example/', siteName: 'Mamaearth', title: null, description: 'Natural skincare.',
  headings: ['Goodness Inside'], ctas: ['Shop now'], bodyText: 'toxin-free', logoCandidates: ['https://cdn.example/logo.png'],
  iconUrls: ['https://mamaearth.example/apple.png'], themeColor: '#00A651', cssColors: ['#00A651'], fonts: ['Poppins'], stylesheetUrl: null,
}
const object = {
  name: 'Mamaearth', oneLiner: 'Toxin-free skincare.', audience: 'Women in Indian cities', region: 'IN',
  toneWords: ['warm', 'caring', 'honest'], emojiPolicy: 'minimal', signaturePhrases: ['Goodness Inside'], ctaExamples: ['Shop now'],
  voiceNotes: '## What we say', colors: { primary: '#00A651', secondary: '', accent: '', text: '', background: '', muted: '' }, headlineFont: 'Poppins',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue(new Response('{"result":"applied"}', { status: 200 }))
  process.env.API_BASE_URL = 'https://api.test'
  process.env.INTERNAL_SERVICE_KEY = 'k'
  downloadImageBase64.mockResolvedValue(PNG_BASE64)
  generate.mockResolvedValue({ object, usage: { inputTokens: 100, outputTokens: 50 } })
})

async function run(inputData: Record<string, unknown>) {
  const { brandImportWorkflow } = await import('./brandImportWorkflow.js')
  const r = await brandImportWorkflow.createRun()
  return r.start({ inputData: inputData as never })
}

function reportBody() {
  return JSON.parse(fetchMock.mock.calls[0][1].body)
}

describe('brandImportWorkflow', () => {
  it('fills from website facts and reports the logo, favicon and source text', async () => {
    const result = await run({ tenantId: T, source: 'website', facts })
    expect(result.status).toBe('success')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/api/v1/internal/brand/import-result')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ tenantId: T, ok: true, logoUrl: 'https://cdn.example/logo.png', faviconUrl: 'https://mamaearth.example/apple.png' })
    expect(body.fields.name).toBe('Mamaearth')
    expect(body.sourceText).toContain('Goodness Inside')
  })

  it('sends the logo image to the fill agent with structured output', async () => {
    await run({ tenantId: T, source: 'website', facts })
    const [messages, options] = generate.mock.calls[0]
    expect(options.structuredOutput.schema).toBeDefined()
    expect(JSON.stringify(messages)).toContain(PNG_BASE64)
  })

  it('reads Instagram through TikHub and uses the profile picture as the logo', async () => {
    fetchInstagramProfile.mockResolvedValue({ handle: 'mamaearth.in', fullName: 'Mamaearth', bio: 'Goodness Inside', externalUrl: null, profilePicUrl: 'https://ig.example/pic.jpg', captions: ['Comment GLOW for the link'] })
    await run({ tenantId: T, source: 'instagram', handle: 'mamaearth.in' })
    const body = reportBody()
    expect(body.logoUrl).toBe('https://ig.example/pic.jpg')
    expect(body.sourceText).toContain('Comment GLOW for the link')
  })

  it('fails the run when Instagram cannot be read', async () => {
    fetchInstagramProfile.mockResolvedValue(null)
    const result = await run({ tenantId: T, source: 'instagram', handle: 'nobody' })
    expect(result.status).toBe('failed')
  })

  it('runs text-only and reports no logoUrl when website facts have no logo or icon candidates', async () => {
    const noLogoFacts = { ...facts, logoCandidates: [], iconUrls: [] }
    const result = await run({ tenantId: T, source: 'website', facts: noLogoFacts })
    expect(result.status).toBe('success')
    expect(downloadImageBase64).not.toHaveBeenCalled()
    const [messages] = generate.mock.calls[0]
    expect(JSON.stringify(messages)).not.toContain('"type":"image"')
    const body = reportBody()
    expect(body.logoUrl).toBeUndefined()
  })

  it('still succeeds, text-only, when the logo download throws', async () => {
    downloadImageBase64.mockRejectedValue(new Error('ENOTFOUND cdn.example'))
    const result = await run({ tenantId: T, source: 'website', facts })
    expect(result.status).toBe('success')
    const [messages] = generate.mock.calls[0]
    expect(JSON.stringify(messages)).not.toContain('"type":"image"')
    const body = reportBody()
    // logoUrl still reported — it's the candidate, not proof the image reached the model.
    expect(body.logoUrl).toBe('https://cdn.example/logo.png')
  })

  it('runs text-only when the downloaded bytes are not png, jpeg or webp', async () => {
    downloadImageBase64.mockResolvedValue(Buffer.from('<!doctype html><title>404</title>').toString('base64'))
    const result = await run({ tenantId: T, source: 'website', facts })
    expect(result.status).toBe('success')
    const [messages] = generate.mock.calls[0]
    expect(JSON.stringify(messages)).not.toContain('"type":"image"')
  })

  it('caps sourceText at 20,000 chars when captions are long', async () => {
    fetchInstagramProfile.mockResolvedValue({
      handle: 'mamaearth.in', fullName: 'Mamaearth', bio: 'Goodness Inside', externalUrl: null,
      profilePicUrl: null, captions: Array.from({ length: 20 }, () => 'x'.repeat(2000)),
    })
    await run({ tenantId: T, source: 'instagram', handle: 'mamaearth.in' })
    const body = reportBody()
    expect(body.sourceText.length).toBeLessThanOrEqual(20_000)
  })

  it('clamps over-length model fields before reporting', async () => {
    generate.mockResolvedValue({
      object: {
        ...object,
        name: 'n'.repeat(100),
        oneLiner: 'o'.repeat(250),
        audience: 'a'.repeat(400),
        voiceNotes: 'v'.repeat(3100),
        headlineFont: 'f'.repeat(70),
        toneWords: ['warm', 'caring', 'honest', 'bold', 'kind', 'extra'],
        signaturePhrases: ['Goodness Inside', 'p'.repeat(90)],
        ctaExamples: ['Shop now', 'c'.repeat(90)],
      },
      usage: { inputTokens: 100, outputTokens: 50 },
    })
    await run({ tenantId: T, source: 'website', facts })
    const body = reportBody()
    expect(body.fields.name.length).toBe(80)
    expect(body.fields.oneLiner.length).toBe(200)
    expect(body.fields.audience.length).toBe(300)
    expect(body.fields.voiceNotes.length).toBe(3000)
    expect(body.fields.headlineFont.length).toBe(60)
    expect(body.fields.toneWords.length).toBe(5)
    expect(body.fields.signaturePhrases).toEqual(['Goodness Inside'])
    expect(body.fields.ctaExamples).toEqual(['Shop now'])
  })
})
