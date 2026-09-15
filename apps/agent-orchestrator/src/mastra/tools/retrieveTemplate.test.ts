// apps/agent-orchestrator/src/mastra/tools/retrieveTemplate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }))
vi.mock('../../db.js', () => ({ makeAppPool: () => getPool() }))

import { retrieveTemplate } from './retrieveTemplate.js'

function ctx(values: Record<string, string>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext } as never
}

function mockClient(rows: unknown[]) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
    release: vi.fn(),
  }
}

// The tool calls makeAppPool(5) exactly once and memoizes the result at
// module scope (same pattern as fetchPRD.ts) — so this mocked pool object
// must be the SAME instance across every test in this file. Each test
// re-arms `pool.connect` to resolve its own client; it must not replace the
// pool itself via a fresh getPool.mockReturnValue(...), or the tool's first
// (and only) makeAppPool() call from an earlier test wins forever.
const pool = { connect: vi.fn(), on: vi.fn() }

beforeEach(() => {
  vi.resetAllMocks()
  // resetAllMocks wipes pool.connect/pool.on's recorded implementation too
  // (they're vi.fn() instances), but not the `pool` object reference itself
  // — re-point getPool at it every test; only the first call the tool ever
  // makes actually matters, but this keeps the mock explicit and safe.
  getPool.mockReturnValue(pool)
})

describe('retrieveTemplate tool', () => {
  it('returns the full contract for a known slug', async () => {
    const row = {
      slug: 'product-demo', title: 'Product Demo', category: 'Demonstration',
      clone_prompt: 'Show the product in use.', negative_prompt: 'No competitor branding.',
      clone_notes: 'One benefit only.', exclude_in_clone: 'Competitor products.',
      technical: { aspectRatio: '9:16', durationSeconds: 15, resolution: '1080x1920', fps: 30 },
      scenes: [{ order: 1, shotType: 'establishing', action: 'Intro.' }],
      reference_file_id: null,
    }
    const client = mockClient([row])
    pool.connect.mockResolvedValue(client)

    const result = await retrieveTemplate.execute!({ slug: 'product-demo' } as never, ctx({ tenantId: 't1' }))

    expect(result).toEqual({
      found: true,
      slug: 'product-demo', title: 'Product Demo', category: 'Demonstration',
      clonePrompt: 'Show the product in use.', negativePrompt: 'No competitor branding.',
      cloneNotes: 'One benefit only.', excludeInClone: 'Competitor products.',
      technical: { aspectRatio: '9:16', durationSeconds: 15, resolution: '1080x1920', fps: 30 },
      scenes: [{ order: 1, shotType: 'establishing', action: 'Intro.' }],
      referenceFileId: null,
    })
    expect(client.release).toHaveBeenCalled()
  })

  it('returns found: false for an unknown slug, without throwing', async () => {
    const client = mockClient([])
    pool.connect.mockResolvedValue(client)

    const result = await retrieveTemplate.execute!({ slug: 'nonexistent' } as never, ctx({ tenantId: 't1' }))

    expect(result).toEqual({ found: false })
  })

  it('scopes the query to global rows or the caller\'s own tenant', async () => {
    const client = mockClient([])
    pool.connect.mockResolvedValue(client)

    await retrieveTemplate.execute!({ slug: 'product-demo' } as never, ctx({ tenantId: 't1' }))

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('tenant_id IS NULL OR ($2'),
      ['product-demo', 't1'],
    )
  })

  it('does not filter by tenant when tenantId is empty (unresolved context) — global templates must still resolve', async () => {
    const row = {
      slug: 'product-demo', title: 'Product Demo', category: 'Demonstration',
      clone_prompt: 'Show the product in use.', negative_prompt: 'No competitor branding.',
      clone_notes: 'One benefit only.', exclude_in_clone: 'Competitor products.',
      technical: { aspectRatio: '9:16', durationSeconds: 15, resolution: '1080x1920', fps: 30 },
      scenes: [{ order: 1, shotType: 'establishing', action: 'Intro.' }],
      reference_file_id: null,
    }
    const client = mockClient([row])
    pool.connect.mockResolvedValue(client)

    // No tenantId set in context at all — ctx({}) leaves requestContext
    // empty, so the tool's `?? ''` default kicks in, same as a real request
    // where tenant resolution hasn't run yet.
    const result = await retrieveTemplate.execute!({ slug: 'product-demo' } as never, ctx({}))

    expect(result).toMatchObject({ found: true, slug: 'product-demo' })
  })
})
