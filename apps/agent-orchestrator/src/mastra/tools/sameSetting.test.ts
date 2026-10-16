// "Same place?" as one shared check (user, 2026-10-16: the fan reel's look 1 had a different rug from looks
// 2-4, and no skill checked it). A missing answer is unknown, never a pass.
import { describe, it, expect, vi } from 'vitest'
import { sameSetting } from './sameSetting.js'

const a = { data: 'AA', mime: 'image/jpeg' }
const b = { data: 'BB', mime: 'image/jpeg' }

describe('sameSetting', () => {
  it('asks about the place only, with both images, and returns the answer', async () => {
    const ask = vi.fn().mockResolvedValue({ same: false, differs: 'dark grey rug, not the cream one' })
    expect(await sameSetting(ask, a, b)).toEqual({ same: false, differs: 'dark grey rug, not the cream one' })
    const parts = ask.mock.calls[0][0]
    expect(parts.filter((p: { image?: unknown }) => p.image)).toHaveLength(2)
    expect(parts.map((p: { text?: string }) => p.text ?? '').join(' ')).toMatch(/Ignore the people/)
  })
  it('a missing or odd answer is unknown (null), never a pass', async () => {
    expect((await sameSetting(vi.fn().mockResolvedValue({}), a, b)).same).toBeNull()
    expect((await sameSetting(vi.fn().mockResolvedValue({ same: 'yes' }), a, b)).same).toBeNull()
    expect((await sameSetting(vi.fn().mockRejectedValue(new Error('down')), a, b)).same).toBeNull()
  })
})
