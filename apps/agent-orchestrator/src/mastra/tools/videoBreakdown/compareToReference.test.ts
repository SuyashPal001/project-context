import { it, expect, vi } from 'vitest'
const bd = vi.fn(); const ai = vi.fn(); const gate = vi.fn()
vi.mock('./breakDownVideo.js', () => ({ breakDownVideo: (...a: unknown[]) => bd(...a) }))
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
