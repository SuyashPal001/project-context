import { it, expect, vi } from 'vitest'
const bd = vi.fn(); const ai = vi.fn(); const gate = vi.fn()
const recent = vi.fn((..._a: unknown[]): unknown => undefined)
vi.mock('./breakDownVideo.js', () => ({ breakDownVideo: (...a: unknown[]) => bd(...a), recentBreakdown: (...a: unknown[]) => recent(...a) }))
vi.mock('./aiServiceClient.js', () => ({ aiService: (...a: unknown[]) => ai(...a) }))
vi.mock('../../scorers/video/gate.js', () => ({ runGate: (...a: unknown[]) => gate(...a) }))
vi.mock('../tvcChecks.js', async (orig) => ({ ...(await orig<object>()), sampleFrames: vi.fn(async (_p: string, t: number[]) => t.map(() => ({ data: 'AA', mime: 'image/jpeg' }))) }))
vi.mock('./fetchVideo.js', () => ({ fetchVideo: vi.fn(async (i: { url?: string; fileId?: string }) => ({ filePath: i.fileId ? '/m/remake.mp4' : '/m/ref.mp4', durationS: 14.9, tooLong: false })) }))
import { pairTimes, compareToReference } from './compareToReference.js'

const ref = { video: { durationS: 14.9 }, hidden_cuts: [{ at_s: 5.4 }, { at_s: 9.2 }], cuts: { cuts: [] }, overview: { moments: [{ t_s: 1.25, measured: true }, { t_s: 3, measured: false }], looks: [{ leg_side: 'image-right', expression: 'poised' }, { leg_side: 'image-left' }, { leg_side: 'image-right' }] } } as any

it('pairs at measured moments and look middles, never at unmeasured times', () => {
  expect(pairTimes(ref)).toEqual([1.25, 2.7, 7.3, 12.05])
})

it('runs pose/legs, expression and same-person gates and compares brightness jumps', async () => {
  bd.mockResolvedValue(ref)
  ai.mockResolvedValueOnce({ count: 0, jumps: [] }).mockResolvedValueOnce({ count: 6, jumps: [] })
  gate.mockResolvedValue({ name: 'x', status: 'pass', reason: '', evidenceTimes: [] })
  const r = await compareToReference({ url: 'https://www.instagram.com/p/x/' }, 'remake-file', { idToken: 't', scopeId: 's', conversationId: 'c' })
  expect(r.brightnessJumps).toEqual({ reference: 0, remake: 6 })
  expect(r.checks.some((c) => c.name === 'brightness-jumps' && c.status === 'fail')).toBe(true)
  expect(gate.mock.calls.map((c) => c[1])).toEqual(expect.arrayContaining(['pose-legs@2.7', 'expression@2.7', 'same-person']))
})

const ctx = { idToken: 't', scopeId: 's', conversationId: 'c' }
const passAll = () => { gate.mockReset(); gate.mockResolvedValue({ name: 'x', status: 'pass', reason: '', evidenceTimes: [] }); ai.mockReset(); ai.mockResolvedValue({ count: 0, jumps: [] }) }

it('reuses the breakdown already made in this conversation instead of paying again (review I3)', async () => {
  passAll(); bd.mockReset(); recent.mockReturnValueOnce(ref)
  await compareToReference({ url: 'https://www.instagram.com/p/x/' }, 'remake-file', ctx)
  expect(bd).not.toHaveBeenCalled()
})

it('caps sample times, keeping measured moments (review I4)', () => {
  const many = { ...ref, hidden_cuts: [], cuts: { cuts: Array.from({ length: 20 }, (_, i) => i * 0.7 + 0.5) }, overview: { ...ref.overview, moments: [{ t_s: 3.33, measured: true }, { t_s: 9.99, measured: true }] } }
  const t = pairTimes(many)
  expect(t.length).toBe(8)
  expect(t).toEqual(expect.arrayContaining([3.33, 9.99]))
})

it('finds each time\'s look by the hidden cut labels, not by list position (review I4)', async () => {
  passAll(); bd.mockReset()
  bd.mockResolvedValue({ video: { durationS: 10 }, hidden_cuts: [{ from: 'a', to: 'b', at_s: 5 }], cuts: { cuts: [] }, overview: { moments: [], looks: [{ label: 'b', leg_side: 'image-left' }, { label: 'a', leg_side: 'image-right' }] } })
  await compareToReference({ url: 'https://www.instagram.com/p/x/' }, 'remake-file', ctx)
  const feet = Object.fromEntries(gate.mock.calls.filter((c) => String(c[1]).startsWith('pose-legs')).map((c) => [c[1], (c[2] as { expectedFeet: string }).expectedFeet]))
  expect(feet).toEqual({ 'pose-legs@2.5': 'image-right', 'pose-legs@7.5': 'image-left' })
})

it('skips the pose/legs check when the look has no leg side (review I4)', async () => {
  passAll(); bd.mockReset()
  bd.mockResolvedValue({ video: { durationS: 10 }, hidden_cuts: [], cuts: { cuts: [5] }, overview: { moments: [], looks: [{ label: 'x' }] } })
  await compareToReference({ url: 'https://www.instagram.com/p/x/' }, 'remake-file', ctx)
  expect(gate.mock.calls.some((c) => String(c[1]).startsWith('pose-legs'))).toBe(false)
})
