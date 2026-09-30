import { describe, it, expect, vi, beforeEach } from 'vitest'

const p = vi.hoisted(() => ({ uploadFileWithKey: vi.fn(), registerTenantAvatar: vi.fn(), setTenantAvatarReference: vi.fn(), findTenantAvatarBySource: vi.fn() }))
vi.mock('../../persistence.js', () => p)
const resolveSourceImage = vi.hoisted(() => vi.fn())
vi.mock('../../media.js', () => ({ resolveSourceImage }))

import { saveAsAvatar } from './saveAsAvatar.js'

const ctx = (values: Record<string, unknown>) => ({ requestContext: { get: (k: string) => values[k] } })
const run = (input: object, values: Record<string, unknown> = { idToken: 'tok', conversationId: 'c1' }) =>
  (saveAsAvatar as any).execute(input, ctx(values))
const input = {
  portraitFileId: '11111111-1111-4111-8111-111111111111',
  referenceSheetFileId: '22222222-2222-4222-8222-222222222222',
  terseTag: 'Riya, long wavy black hair, light blue top', styleLock: 'photoreal, soft daylight, 50mm',
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveSourceImage.mockResolvedValue({ base64: Buffer.from('img').toString('base64'), mimeType: 'image/png' })
  p.uploadFileWithKey.mockImplementation(async (_t: string, i: { key: string; name: string }) => ({ fileId: i.key.startsWith('creative-avatars/') ? 'portrait-copy' : 'sheet-copy', name: i.name, type: 'image/png', size: 3 }))
  p.registerTenantAvatar.mockResolvedValue({ id: 'a1', fileId: 'portrait-copy', name: 'Riya', role: 'Fitness creator', tone: 'Energetic' })
  p.setTenantAvatarReference.mockResolvedValue(true)
  p.findTenantAvatarBySource.mockResolvedValue(null)
})

describe('save_as_avatar', () => {
  it('copies the portrait into Avatars, the sheet into avatar-refs, and pins the anchor', async () => {
    const out = await run(input)
    expect(out).toEqual({ saved: true, avatarId: 'a1', fileId: 'portrait-copy', name: 'Riya', role: 'Fitness creator', tone: 'Energetic', referenceSheet: true })
    const keys = p.uploadFileWithKey.mock.calls.map((c: any[]) => c[1].key)
    expect(keys[0]).toMatch(/^creative-avatars\/[0-9a-f-]{36}-avatar\.png$/)
    expect(keys[1]).toMatch(/^avatar-refs\/a1\/[0-9a-f-]{36}-sheet\.png$/)
    expect(p.setTenantAvatarReference).toHaveBeenCalledWith('tok', 'a1', { referenceSheetFileId: 'sheet-copy', terseTag: input.terseTag, styleLock: input.styleLock })
    expect(p.registerTenantAvatar).toHaveBeenCalledWith('tok', 'portrait-copy', input.portraitFileId)
  })

  it('returns the existing avatar untouched when the picked portrait already has a sheet', async () => {
    p.findTenantAvatarBySource.mockResolvedValue({ id: 'existing1', fileId: 'existing-file', name: 'Riya', role: 'Fitness creator', tone: 'Energetic', referenceSheetFileId: 'sheet-existing' })
    const out = await run(input)
    expect(out).toEqual({ saved: true, avatarId: 'existing1', fileId: 'existing-file', name: 'Riya', role: 'Fitness creator', tone: 'Energetic', referenceSheet: true })
    expect(p.uploadFileWithKey).not.toHaveBeenCalled()
    expect(p.registerTenantAvatar).not.toHaveBeenCalled()
    expect(p.setTenantAvatarReference).not.toHaveBeenCalled()
  })

  it('runs only the sheet step when the existing avatar has no sheet yet', async () => {
    p.findTenantAvatarBySource.mockResolvedValue({ id: 'existing1', fileId: 'existing-file', name: 'Riya', role: 'Fitness creator', tone: 'Energetic', referenceSheetFileId: null })
    const out = await run(input)
    expect(out).toEqual({ saved: true, avatarId: 'existing1', fileId: 'existing-file', name: 'Riya', role: 'Fitness creator', tone: 'Energetic', referenceSheet: true })
    expect(p.uploadFileWithKey).toHaveBeenCalledTimes(1)
    expect(p.uploadFileWithKey.mock.calls[0][1].key).toMatch(/^avatar-refs\/existing1\/[0-9a-f-]{36}-sheet\.png$/)
    expect(p.registerTenantAvatar).not.toHaveBeenCalled()
    expect(p.setTenantAvatarReference).toHaveBeenCalledWith('tok', 'existing1', { referenceSheetFileId: 'sheet-copy', terseTag: input.terseTag, styleLock: input.styleLock })
  })

  it('keeps the saved avatar when the sheet step fails', async () => {
    p.setTenantAvatarReference.mockResolvedValue(false)
    expect(await run(input)).toMatchObject({ saved: true, avatarId: 'a1', referenceSheet: false })
  })

  it('refuses without a signed-in user', async () => {
    expect(await run(input, {})).toEqual({ saved: false, reason: 'NOT_AUTHENTICATED' })
  })

  it('reports an unreadable portrait without uploading anything', async () => {
    resolveSourceImage.mockResolvedValueOnce(null)
    expect(await run(input)).toEqual({ saved: false, reason: 'SOURCE_IMAGE_UNAVAILABLE' })
    expect(p.uploadFileWithKey).not.toHaveBeenCalled()
  })

  it('reports a failed registration', async () => {
    p.registerTenantAvatar.mockResolvedValue(null)
    expect(await run(input)).toEqual({ saved: false, reason: 'REGISTER_FAILED' })
  })

  it('passes the category through so the picker can filter the saved avatar', async () => {
    await run({ ...input, category: 'Animation' })
    expect(p.setTenantAvatarReference).toHaveBeenCalledWith('tok', 'a1', { referenceSheetFileId: 'sheet-copy', terseTag: input.terseTag, styleLock: input.styleLock, category: 'Animation' })
  })
})
