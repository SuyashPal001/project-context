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
const ctx = (...args: [] | [string | undefined]) => {
  const idToken = args.length === 0 ? 'tok' : args[0]
  const rc = new RequestContext()
  if (idToken) rc.set('idToken', idToken)
  return { requestContext: rc } as never
}

describe('update_brand', () => {
  it('PATCHes only the given fields with the user token', async () => {
    fetchMock.mockResolvedValue(new Response('{"data":{}}', { status: 200 }))
    const { updateBrandTool } = await import('./brandTools.js')
    const out = await updateBrandTool.execute!({ bannedPhrases: ['cheap'] } as never, ctx())
    expect(out).toMatchObject({ success: true })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/api/v1/brand')
    expect(init.method).toBe('PATCH')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body)).toEqual({ bannedPhrases: ['cheap'] })
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
