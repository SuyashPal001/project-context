import { describe, it, expect, vi } from 'vitest'
vi.mock('../../db.js', () => ({ makeAppPool: vi.fn() }))
import { expandAvatarReferences } from './avatarReferences.js'

const q = (rows: Array<{ file_id: string; sheet: string }>) => vi.fn().mockResolvedValue({ rows })

describe('expandAvatarReferences', () => {
  it('adds an avatar\'s sheet right after its portrait', async () => {
    const query = q([{ file_id: 'p1', sheet: 's1' }])
    expect(await expandAvatarReferences('t1', ['p1', 'x'], query)).toEqual(['p1', 's1', 'x'])
    expect(query.mock.calls[0][1]).toEqual(['t1', ['p1', 'x']])
  })

  it('never exceeds 3 references, keeping every original', async () => {
    expect(await expandAvatarReferences('t1', ['p1', 'x', 'y'], q([{ file_id: 'p1', sheet: 's1' }]))).toEqual(['p1', 'x', 'y'])
    expect(await expandAvatarReferences('t1', ['p1', 'x'], q([{ file_id: 'p1', sheet: 's1' }, { file_id: 'x', sheet: 's2' }]))).toEqual(['p1', 's1', 'x'])
  })

  it('does not duplicate a sheet already passed', async () => {
    expect(await expandAvatarReferences('t1', ['p1', 's1'], q([{ file_id: 'p1', sheet: 's1' }]))).toEqual(['p1', 's1'])
  })

  it('returns the input untouched with no tenant or on a db error', async () => {
    const query = q([])
    expect(await expandAvatarReferences('', ['p1'], query)).toEqual(['p1'])
    expect(query).not.toHaveBeenCalled()
    expect(await expandAvatarReferences('t1', ['p1'], vi.fn().mockRejectedValue(new Error('down')))).toEqual(['p1'])
  })
})
