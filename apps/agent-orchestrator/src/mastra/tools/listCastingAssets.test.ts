// apps/agent-orchestrator/src/mastra/tools/listCastingAssets.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }))
vi.mock('../../db.js', () => ({ makeAppPool: () => getPool() }))

import { listCastingAssets } from './listCastingAssets.js'

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

// Same pool-memoization caveat as retrieveTemplate.test.ts: the tool calls
// makeAppPool(5) once and memoizes it at module scope, so this mocked pool
// object must be the same instance across every test in this file.
const pool = { connect: vi.fn(), on: vi.fn() }

beforeEach(() => {
  vi.resetAllMocks()
  getPool.mockReturnValue(pool)
})

describe('listCastingAssets tool', () => {
  it('fetches avatars scoped to platform-owned or the caller\'s tenant', async () => {
    const client = mockClient([
      { id: 'a1', name: 'Mira', attributes: { role: 'Everyday creator', tone: 'Casual' } },
      { id: 'a2', name: 'Arjun', attributes: { role: 'Tech presenter', tone: 'Clear' } },
    ])
    pool.connect.mockResolvedValue(client)

    const result = await listCastingAssets.execute!({ kind: 'avatar' } as never, ctx({ tenantId: 't1' }))

    expect(result).toEqual({
      items: [
        { id: 'a1', name: 'Mira', description: 'Everyday creator · Casual' },
        { id: 'a2', name: 'Arjun', description: 'Tech presenter · Clear' },
      ],
    })
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("kind = 'avatar'"),
      ['t1'],
    )
    expect(client.release).toHaveBeenCalled()
  })

  it('does not filter avatars by tenant when tenantId is unresolved', async () => {
    const client = mockClient([])
    pool.connect.mockResolvedValue(client)

    await listCastingAssets.execute!({ kind: 'avatar' } as never, ctx({}))

    expect(client.query).toHaveBeenCalledWith(expect.any(String), [''])
  })

  it('fetches the voice catalogue with no tenant scoping', async () => {
    const client = mockClient([
      { provider_id: 'nandi', name: 'Nandi', tagline: 'Poised concierge', description: null },
      { provider_id: 'asher', name: 'Asher', tagline: 'Warm narrator', description: 'Great for explainers' },
    ])
    pool.connect.mockResolvedValue(client)

    const result = await listCastingAssets.execute!({ kind: 'voice' } as never, ctx({ tenantId: 't1' }))

    expect(result).toEqual({
      items: [
        { id: 'nandi', name: 'Nandi', description: 'Poised concierge' },
        { id: 'asher', name: 'Asher', description: 'Warm narrator — Great for explainers' },
      ],
    })
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('voice_catalogue'))
  })

  it('handles an empty catalogue without throwing', async () => {
    const client = mockClient([])
    pool.connect.mockResolvedValue(client)

    const result = await listCastingAssets.execute!({ kind: 'voice' } as never, ctx({}))

    expect(result).toEqual({ items: [] })
  })
})
