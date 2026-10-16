import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const fetchMock = vi.fn()
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.stubGlobal('fetch', fetchMock)
  process.env.API_BASE_URL = 'https://api.test'
})
// Not a default parameter: `ctx(undefined)` (used below to mean "no token")
// would otherwise fall through to the 'tok' default too, since JS applies a
// default parameter whenever the argument is undefined, explicit or omitted.
const ctx = (...args: [] | [string | undefined] | [string | undefined, Record<string, unknown>]) => {
  const idToken = args.length === 0 ? 'tok' : args[0]
  const rc = new RequestContext()
  if (idToken) rc.set('idToken', idToken)
  if (args[1]) rc.set('brand', args[1])
  return { requestContext: rc } as never
}
const saved = {
  name: 'Mamaearth', toneWords: ['warm', 'caring'], signaturePhrases: ['Goodness Inside'],
  bannedPhrases: ['chemical-free', 'Cheap'], ctaExamples: ['Shop now'], colors: { primary: '#00A651', accent: '#FFCC00' },
}
const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body)

describe('update_brand', () => {
  it('PATCHes only the given fields with the user token', async () => {
    fetchMock.mockResolvedValue(new Response('{"data":{}}', { status: 200 }))
    const { updateBrandTool } = await import('./brandTools.js')
    const out = await updateBrandTool.execute!({ addBannedPhrases: ['cheap'] } as never, ctx())
    expect(out).toMatchObject({ success: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/api/v1/brand')
    expect(init.method).toBe('PATCH')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toEqual({ bannedPhrases: ['cheap'] })
  })

  it('adding a banned phrase keeps the saved ones', async () => {
    fetchMock.mockResolvedValue(new Response('{"data":{}}', { status: 200 }))
    const { updateBrandTool } = await import('./brandTools.js')
    await updateBrandTool.execute!({ addBannedPhrases: ['miracle', 'cheap'] } as never, ctx('tok', saved))
    expect(sentBody()).toEqual({ bannedPhrases: ['chemical-free', 'Cheap', 'miracle'] })
  })

  it('removes case-insensitively, then adds', async () => {
    fetchMock.mockResolvedValue(new Response('{"data":{}}', { status: 200 }))
    const { updateBrandTool } = await import('./brandTools.js')
    await updateBrandTool.execute!({ removeToneWords: ['WARM'], addToneWords: ['bold'], removeCtaExamples: ['shop now'] } as never, ctx('tok', saved))
    expect(sentBody()).toEqual({ toneWords: ['caring', 'bold'], ctaExamples: [] })
  })

  it('caps a list at its limit', async () => {
    fetchMock.mockResolvedValue(new Response('{"data":{}}', { status: 200 }))
    const { updateBrandTool } = await import('./brandTools.js')
    await updateBrandTool.execute!({ addToneWords: ['a', 'b', 'c', 'd'] } as never, ctx('tok', saved))
    expect(sentBody().toneWords).toEqual(['warm', 'caring', 'a', 'b', 'c'])
  })

  it('a second edit in the same turn builds on the first', async () => {
    fetchMock.mockImplementation(async () => new Response('{"data":{}}', { status: 200 }))
    const { updateBrandTool } = await import('./brandTools.js')
    const c = ctx('tok', saved)
    await updateBrandTool.execute!({ addBannedPhrases: ['miracle'], colors: { text: '#000000' } } as never, c)
    await updateBrandTool.execute!({ addBannedPhrases: ['instant'] } as never, c)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ bannedPhrases: ['chemical-free', 'Cheap', 'miracle', 'instant'] })
    const brand = (c as unknown as { requestContext: RequestContext }).requestContext.get('brand') as Record<string, unknown>
    expect(brand.colors).toEqual({ primary: '#00A651', accent: '#FFCC00', text: '#000000' })
  })

  it('a first list edit with no saved brand starts from empty and is kept for the next', async () => {
    fetchMock.mockImplementation(async () => new Response('{"data":{}}', { status: 200 }))
    const { updateBrandTool } = await import('./brandTools.js')
    const c = ctx()
    await updateBrandTool.execute!({ addToneWords: ['warm'] } as never, c)
    await updateBrandTool.execute!({ addToneWords: ['bold'] } as never, c)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ toneWords: ['warm', 'bold'] })
  })

  it('sends only the colour roles given', async () => {
    fetchMock.mockResolvedValue(new Response('{"data":{}}', { status: 200 }))
    const { updateBrandTool } = await import('./brandTools.js')
    await updateBrandTool.execute!({ colors: { accent: '#112233' } } as never, ctx('tok', saved))
    expect(sentBody()).toEqual({ colors: { accent: '#112233' } })
  })

  it('reports a plain failure without internals', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"x"}', { status: 500 }))
    const { updateBrandTool } = await import('./brandTools.js')
    const out = await updateBrandTool.execute!({ name: 'X' } as never, ctx()) as { success: boolean; error: string }
    expect(out.success).toBe(false)
    expect(out.error).not.toMatch(/500|server|status/i)
  })

  it('refuses outside a live chat', async () => {
    const { updateBrandTool } = await import('./brandTools.js')
    expect(await updateBrandTool.execute!({ name: 'X' } as never, ctx(undefined))).toMatchObject({ success: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('import_brand', () => {
  it('POSTs the value and says the brand is being read', async () => {
    fetchMock.mockResolvedValue(new Response('{"data":{"importStatus":"importing"}}', { status: 202 }))
    const { importBrandTool } = await import('./brandTools.js')
    const out = await importBrandTool.execute!({ value: '@mamaearth.in' } as never, ctx())
    expect(out).toMatchObject({ success: true, status: 'importing' })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ value: '@mamaearth.in' })
  })

  it('passes on the "not a site or handle" message', async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"Paste a website link or an Instagram handle"}', { status: 400 }))
    const { importBrandTool } = await import('./brandTools.js')
    expect(await importBrandTool.execute!({ value: 'hi' } as never, ctx())).toMatchObject({ success: false, error: 'Paste a website link or an Instagram handle' })
  })
})
