import { describe, it, expect, vi } from 'vitest'
import { fetchAllowedSubAgents } from '../usage.js'

describe('fetchAllowedSubAgents', () => {
  it('asks only for platform-owned or own-tenant templates that are published', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ name: 'director' }] })
    await fetchAllowedSubAgents('t1', { query } as never)
    const [sql, values] = query.mock.calls[0]
    expect(sql).toMatch(/tenant_id is null/i)
    expect(sql).toMatch(/status = 'published'/i)
    expect(values).toEqual(['t1'])
  })

  it('returns the code spec ids plus any rows', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ name: 'stylist' }] })
    const allowed = await fetchAllowedSubAgents('t1', { query } as never)
    expect(allowed).toEqual(expect.arrayContaining(['pm', 'architect', 'director', 'producer', 'stylist']))
  })

  it('returns the code spec ids when the query fails, so a DB blip does not silently strip capability', async () => {
    const query = vi.fn().mockRejectedValue(new Error('pool down'))
    expect((await fetchAllowedSubAgents('t1', { query } as never)).sort())
      .toEqual(['architect', 'director', 'pm', 'producer'])
  })
})
