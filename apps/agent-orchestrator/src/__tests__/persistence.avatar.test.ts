import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.stubGlobal('fetch', fetchMock); process.env.API_BASE_URL = 'https://api.example' })
const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => '' })

describe('uploadFileWithKey', () => {
  it('uploads under the caller\'s key and confirms', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ data: { fileId: 'f1', uploadUrl: 'https://s3/put' } }))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(ok({}))
    const { uploadFileWithKey } = await import('../persistence.js')
    const out = await uploadFileWithKey('tok', { key: 'creative-avatars/u-avatar.png', name: 'avatar.png', content: Buffer.from('x'), contentType: 'image/png' })
    expect(out).toEqual({ fileId: 'f1', name: 'avatar.png', type: 'image/png', size: 1 })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ key: 'creative-avatars/u-avatar.png', filename: 'avatar.png' })
  })

  it('returns null when confirm fails', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ data: { fileId: 'f1', uploadUrl: 'https://s3/put' } }))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => '' })
    const { uploadFileWithKey } = await import('../persistence.js')
    expect(await uploadFileWithKey('tok', { key: 'k', name: 'n.png', content: Buffer.from('x'), contentType: 'image/png' })).toBeNull()
  })
})

describe('tenant avatar helpers', () => {
  it('registers and returns the named avatar', async () => {
    fetchMock.mockResolvedValueOnce(ok({ data: { id: 'a1', fileId: 'f1', name: 'Riya', role: 'Fitness creator', tone: 'Energetic' } }))
    const { registerTenantAvatar } = await import('../persistence.js')
    expect(await registerTenantAvatar('tok', 'f1')).toMatchObject({ id: 'a1', name: 'Riya' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example/api/v1/creative-library-assets/avatars')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ fileId: 'f1' })
  })

  it('registers with sourceFileId when given', async () => {
    fetchMock.mockResolvedValueOnce(ok({ data: { id: 'a1', fileId: 'f1', name: 'Riya', role: 'Fitness creator', tone: 'Energetic', referenceSheetFileId: null } }))
    const { registerTenantAvatar } = await import('../persistence.js')
    const result = await registerTenantAvatar('tok', 'f1', 'src1')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ fileId: 'f1', sourceFileId: 'src1' })
    expect(result).toMatchObject({ referenceSheetFileId: null })
  })

  it('reports a failed reference pin as false', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => '' })
    const { setTenantAvatarReference } = await import('../persistence.js')
    expect(await setTenantAvatarReference('tok', 'a1', { referenceSheetFileId: 's1', terseTag: 't', styleLock: 's' })).toBe(false)
  })
})

describe('findTenantAvatarBySource', () => {
  it('returns the avatar record on a hit', async () => {
    fetchMock.mockResolvedValueOnce(ok({ data: { id: 'a1', fileId: 'f1', name: 'Riya', role: 'Fitness creator', tone: 'Energetic', referenceSheetFileId: 'sheet1' } }))
    const { findTenantAvatarBySource } = await import('../persistence.js')
    const out = await findTenantAvatarBySource('tok', 'src1')
    expect(out).toEqual({ id: 'a1', fileId: 'f1', name: 'Riya', role: 'Fitness creator', tone: 'Energetic', referenceSheetFileId: 'sheet1' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example/api/v1/creative-library-assets/avatars/by-source/src1')
  })

  it('returns null on a 404', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' })
    const { findTenantAvatarBySource } = await import('../persistence.js')
    expect(await findTenantAvatarBySource('tok', 'src1')).toBeNull()
  })

  it('returns null on any other failure, logged', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
    const { findTenantAvatarBySource } = await import('../persistence.js')
    expect(await findTenantAvatarBySource('tok', 'src1')).toBeNull()
  })

  it('returns null when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'))
    const { findTenantAvatarBySource } = await import('../persistence.js')
    expect(await findTenantAvatarBySource('tok', 'src1')).toBeNull()
  })
})
