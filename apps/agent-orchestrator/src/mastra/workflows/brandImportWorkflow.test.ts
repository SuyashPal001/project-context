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
  downloadImageBase64.mockResolvedValue('aGVsbG8=')
  generate.mockResolvedValue({ object, usage: { inputTokens: 100, outputTokens: 50 } })
})

async function run(inputData: Record<string, unknown>) {
  const { brandImportWorkflow } = await import('./brandImportWorkflow.js')
  const r = await brandImportWorkflow.createRun()
  return r.start({ inputData: inputData as never })
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
    expect(JSON.stringify(messages)).toContain('aGVsbG8=')
  })

  it('reads Instagram through TikHub and uses the profile picture as the logo', async () => {
    fetchInstagramProfile.mockResolvedValue({ handle: 'mamaearth.in', fullName: 'Mamaearth', bio: 'Goodness Inside', externalUrl: null, profilePicUrl: 'https://ig.example/pic.jpg', captions: ['Comment GLOW for the link'] })
    await run({ tenantId: T, source: 'instagram', handle: 'mamaearth.in' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.logoUrl).toBe('https://ig.example/pic.jpg')
    expect(body.sourceText).toContain('Comment GLOW for the link')
  })

  it('fails the run when Instagram cannot be read', async () => {
    fetchInstagramProfile.mockResolvedValue(null)
    const result = await run({ tenantId: T, source: 'instagram', handle: 'nobody' })
    expect(result.status).toBe('failed')
  })
})
