// Two remotes again (2026-10-17, Omni; Oct 14, Omni and the hand-made v4): a clip invents or doubles an
// object and no check counted them. A shared count, frame by frame, against the approved start photo.
import { describe, it, expect, vi } from 'vitest'
import { countProps, duplicatedProps, missingProps } from './propCount.js'

const img = (d: string) => ({ data: d, mime: 'image/jpeg' })

describe('countProps', () => {
  it('asks for each object and reads the counts; a missing answer is null', async () => {
    const ask = vi.fn().mockResolvedValue({ counts: { 'TV remote': 2 } })
    expect(await countProps(ask, img('a'), ['TV remote', 'bouquet'])).toEqual({ 'TV remote': 2, bouquet: null })
    expect(ask.mock.calls[0][0].map((p: { text?: string }) => p.text ?? '').join(' ')).toMatch(/"TV remote", "bouquet"/)
  })
})

describe('duplicatedProps', () => {
  it('an object seen more times than in the start photo fails, with the time', async () => {
    const ask = vi.fn(async (parts: Array<{ image?: { data: string } }>) => ({ counts: { 'TV remote': parts.some((p) => p.image?.data === 'f2') ? 2 : 1 } }))
    const r = await duplicatedProps(ask as never, img('start'), [{ t: 1, img: img('f1') }, { t: 2, img: img('f2') }], ['TV remote'])
    expect(r.status).toBe('fail')
    expect(r.reason).toMatch(/2 TV remote at 2s \(the start photo has 1\)/)
  })
  it('the same counts pass; no answer at all is unknown, never a pass', async () => {
    expect((await duplicatedProps(vi.fn().mockResolvedValue({ counts: { 'TV remote': 1 } }), img('s'), [{ t: 1, img: img('f') }], ['TV remote'])).status).toBe('pass')
    expect((await duplicatedProps(vi.fn().mockResolvedValue({}), img('s'), [{ t: 1, img: img('f') }], ['TV remote'])).status).toBe('unknown')
  })
})

// Fan run real14 (2026-10-17): the TV remote by her hand in every look of the original was gone from look 3's
// photos, and nothing checked for a missing object.
describe('missingProps', () => {
  const askWith = (byImage: Record<string, number>) => vi.fn(async (parts: Array<{ image?: { data: string } }>) => ({ counts: { 'TV remote': byImage[parts[0].image!.data] } })) as never
  it('an object the original frame shows and the photo lacks is missing', async () => {
    const r = await missingProps(askWith({ orig: 1, still: 0 }), img('orig'), img('still'), ['TV remote'])
    expect(r).toEqual({ status: 'fail', reason: 'missing from the photo: TV remote (the original frame shows 1)' })
  })
  it('as many as the original passes; more is the duplicate check\'s job', async () => {
    expect((await missingProps(askWith({ orig: 1, still: 1 }), img('orig'), img('still'), ['TV remote'])).status).toBe('pass')
    expect((await missingProps(askWith({ orig: 1, still: 2 }), img('orig'), img('still'), ['TV remote'])).status).toBe('pass')
  })
  it('a count that could not be made is unknown, never a pass', async () => {
    expect((await missingProps(vi.fn().mockRejectedValue(new Error('x')), img('orig'), img('still'), ['TV remote'])).status).toBe('unknown')
  })
})
