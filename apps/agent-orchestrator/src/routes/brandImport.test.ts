import { describe, it, expect, vi, beforeEach } from 'vitest'

const start = vi.fn()
vi.mock('../mastra/workflows/brandImportWorkflow.js', () => ({
  brandImportWorkflow: { createRun: async () => ({ runId: 'run-1', start: (...a: unknown[]) => start(...a) }) },
  reportImportResult: vi.fn(),
}))
const T = '11111111-1111-4111-8111-111111111111'

beforeEach(() => { vi.clearAllMocks(); process.env.INTERNAL_SERVICE_KEY = 'k'; start.mockResolvedValue({ status: 'success' }) })

async function call(body: unknown, key = 'k') {
  const { brandImportRouter } = await import('./brandImport.js')
  return brandImportRouter.request('/internal/brand/import', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Service-Key': key }, body: JSON.stringify(body) })
}

describe('POST /internal/brand/import', () => {
  it('refuses without the service key', async () => {
    expect((await call({ tenantId: T, source: 'instagram', handle: 'x' }, 'bad')).status).toBe(401)
  })

  it('starts the workflow and acks with 202 before it finishes', async () => {
    start.mockReturnValue(new Promise(() => {})) // never resolves
    const res = await call({ tenantId: T, source: 'instagram', handle: 'mamaearth.in' })
    expect(res.status).toBe(202)
    expect(start).toHaveBeenCalledWith({ inputData: { tenantId: T, source: 'instagram', handle: 'mamaearth.in' } })
  })

  it('rejects a body with no handle or facts', async () => {
    expect((await call({ tenantId: T, source: 'website' })).status).toBe(400)
  })
})
