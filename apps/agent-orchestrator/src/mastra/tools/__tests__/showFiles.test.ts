import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@serverless-saas/database', () => ({ db: { execute } }))

import { showFilesTool, fetchTenantFile, inputSchema as showFilesInputSchema } from '../showFiles.js'

function ctx(tenantId?: string) {
  const requestContext = new RequestContext()
  if (tenantId !== undefined) requestContext.set('tenantId', tenantId)
  return { requestContext } as never
}

describe('fetchTenantFile', () => {
  beforeEach(() => execute.mockReset())

  it('returns the file when it belongs to the tenant', async () => {
    execute.mockResolvedValue([{ file_id: 'f1', name: 'a.png', mime_type: 'image/png', size: 10 }])
    expect(await fetchTenantFile('t1', 'f1')).toEqual({ fileId: 'f1', name: 'a.png', fileType: 'image/png', size: 10 })
  })

  it('returns null when the query finds nothing (wrong tenant or nonexistent)', async () => {
    execute.mockResolvedValue([])
    expect(await fetchTenantFile('t1', 'f-other-tenant')).toBeNull()
  })

  it('returns null without querying when tenantId or fileId is empty', async () => {
    expect(await fetchTenantFile('', 'f1')).toBeNull()
    expect(execute).not.toHaveBeenCalled()
  })
})

const F1 = '11111111-1111-1111-1111-111111111111'
const F2 = '22222222-2222-2222-2222-222222222222'

describe('showFilesTool', () => {
  beforeEach(() => execute.mockReset())

  it('returns files + missing for a mix of owned and unknown fileIds', async () => {
    execute
      .mockResolvedValueOnce([{ file_id: F1, name: 'a.png', mime_type: 'image/png', size: 10 }])
      .mockResolvedValueOnce([])
    const result = await showFilesTool.execute!({ fileIds: [F1, F2] } as never, ctx('t1'))
    expect(result).toEqual({
      files: [{ fileId: F1, name: 'a.png', fileType: 'image/png', size: 10 }],
      missing: [F2],
    })
  })

  it('rejects another tenant\'s file — the DB query is tenant-scoped, so it comes back missing', async () => {
    execute.mockResolvedValue([]) // t2's query for t1's file matches nothing
    const result = await showFilesTool.execute!({ fileIds: [F1] } as never, ctx('t2'))
    expect(result).toEqual({ files: [], missing: [F1] })
  })

  it('returns everything missing when no tenant is on the request context', async () => {
    const result = await showFilesTool.execute!({ fileIds: [F1] } as never, ctx(undefined))
    expect(result).toEqual({ files: [], missing: [F1] })
    expect(execute).not.toHaveBeenCalled()
  })
})

// M4: a 30s TVC ad plans up to 20 shots (tvcPlan.ts's MAX_SHOTS_30); "show them
// all together" (tvc-ad.md item 4) must not be refused by show_files' own cap.
describe('showFilesTool input schema cap', () => {
  const mkIds = (n: number) => Array.from({ length: n }, (_, i) =>
    `${String(i + 1).padStart(8, '0')}-1111-1111-1111-111111111111`)

  it('accepts 20 fileIds', () => {
    expect(showFilesInputSchema.safeParse({ fileIds: mkIds(20) }).success).toBe(true)
  })

  it('refuses 21 fileIds', () => {
    expect(showFilesInputSchema.safeParse({ fileIds: mkIds(21) }).success).toBe(false)
  })
})
