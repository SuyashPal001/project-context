import { describe, it, expect, vi } from 'vitest'
vi.mock('../../db.js', () => ({ makeAppPool: vi.fn() }))
import { expandAvatarReferences, resolveAvatarReferences } from './avatarReferences.js'

const q = (rows: Array<{ file_id: string; sheet: string; terse_tag?: string | null; style_lock?: string | null }>) => vi.fn().mockResolvedValue({ rows })

describe('expandAvatarReferences', () => {
  it('adds an avatar\'s sheet right after its portrait', async () => {
    const query = q([{ file_id: 'p1', sheet: 's1' }])
    expect(await expandAvatarReferences('t1', ['p1', 'x'], query)).toEqual(['p1', 's1', 'x'])
    expect(query.mock.calls[0][1]).toEqual(['t1', ['p1', 'x']])
  })

  it('only expands references whose asset row is kind=avatar', async () => {
    const query = q([{ file_id: 'p1', sheet: 's1' }])
    await expandAvatarReferences('t1', ['p1', 'x'], query)
    expect(query.mock.calls[0][0]).toMatch(/a\.kind\s*=\s*'avatar'/)
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

describe('resolveAvatarReferences', () => {
  it('returns the anchor of the portrait\'s avatar', async () => {
    const query = q([{ file_id: 'p1', sheet: 's1', terse_tag: 'the woman in the yellow cardigan', style_lock: 'warm morning light, 35mm lens' }])
    const result = await resolveAvatarReferences('t1', ['p1', 'x'], query)
    expect(result.fileIds).toEqual(['p1', 's1', 'x'])
    expect(result.anchor).toEqual({ terseTag: 'the woman in the yellow cardigan', styleLock: 'warm morning light, 35mm lens' })
  })

  it('returns a null anchor when no row has both keys', async () => {
    const query = q([{ file_id: 'p1', sheet: 's1', terse_tag: null, style_lock: null }])
    const result = await resolveAvatarReferences('t1', ['p1', 'x'], query)
    expect(result.fileIds).toEqual(['p1', 's1', 'x'])
    expect(result.anchor).toBeNull()
  })

  it('returns a null anchor with no tenant, 3+ references, or a db error', async () => {
    expect((await resolveAvatarReferences('', ['p1'], q([]))).anchor).toBeNull()
    expect((await resolveAvatarReferences('t1', ['p1', 'x', 'y'], q([]))).anchor).toBeNull()
    expect((await resolveAvatarReferences('t1', ['p1'], vi.fn().mockRejectedValue(new Error('down')))).anchor).toBeNull()
  })

  it('expandAvatarReferences stays a thin wrapper returning just the fileIds', async () => {
    const query = q([{ file_id: 'p1', sheet: 's1', terse_tag: 'tag', style_lock: 'lock' }])
    expect(await expandAvatarReferences('t1', ['p1', 'x'], query)).toEqual(['p1', 's1', 'x'])
  })
})
