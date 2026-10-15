import { it, expect, vi } from 'vitest'
const bd = vi.fn(); const ai = vi.fn(); const gate = vi.fn()
const recent = vi.fn((..._a: unknown[]): unknown => undefined)
vi.mock('./breakDownVideo.js', () => ({ breakDownVideo: (...a: unknown[]) => bd(...a), recentBreakdown: (...a: unknown[]) => recent(...a) }))
vi.mock('./aiServiceClient.js', () => ({ aiService: (...a: unknown[]) => ai(...a) }))
vi.mock('../../scorers/video/gate.js', () => ({ runGate: (...a: unknown[]) => gate(...a) }))
const sample = vi.fn(async (p: string, t: number[], _d: string, crop?: number[]) => t.map((x) => ({ data: `${crop ? 'face:' : ''}${p}@${x}`, mime: 'image/jpeg' })))
const side = vi.fn(async (..._a: unknown[]) => Buffer.from('jpg'))
vi.mock('../tvcChecks.js', async (orig) => ({ ...(await orig<object>()), sampleFrames: (...a: unknown[]) => sample(...(a as [string, number[], string, number[]?])), sideBySide: (...a: unknown[]) => side(...a) }))
const upload = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ fileId: 'ev1', name: 'e.jpg', type: 'image', size: 3 }))
vi.mock('../../../persistence.js', () => ({ uploadFileWithKey: (...a: unknown[]) => upload(...a), generatedFileKey: (c: string, t: string) => `generated/${c}/${t}.jpg` }))
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
  expect(gate.mock.calls.map((c) => c[1])).toEqual(expect.arrayContaining(['pose-legs@2.7', 'expression@2.7', 'same-person@1.25']))
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

it('brightness jumps must match the reference count — fewer is a difference too (review M2)', async () => {
  passAll(); bd.mockReset(); bd.mockResolvedValue(ref)
  ai.mockReset(); ai.mockResolvedValueOnce({ count: 4, jumps: [] }).mockResolvedValueOnce({ count: 1, jumps: [] })
  const r = await compareToReference({ url: 'https://www.instagram.com/p/x/' }, 'remake-file', ctx)
  expect(r.checks.find((c) => c.name === 'brightness-jumps')?.status).toBe('fail')
})

it('the tool refuses to spend on checks it cannot bill to a tenant (review M4)', async () => {
  const { compareToReferenceTool } = await import('./compareToReference.js')
  const rc = new Map<string, string>([['idToken', 't'], ['sessionId', 's'], ['conversationId', 'c']])
  const r = await (compareToReferenceTool as any).execute({ referenceUrl: 'https://www.instagram.com/p/x/', remakeFileId: 'f' }, { requestContext: rc })
  expect(r).toMatchObject({ success: false, error: 'no_tenant' })
})

const angled = { video: { durationS: 14 }, hidden_cuts: [], cuts: { cuts: [3.5, 7, 10.5] }, overview: { subject_box: [0.2, 0.1, 0.8, 0.9], moments: [], looks: [{ label: 'a', expression: 'poised' }] },
  shots: [{ n: 1, start_s: 0, end_s: 3.5, size: 'wide', angle: 'overhead' }, { n: 2, start_s: 3.5, end_s: 7, size: 'close', angle: 'eye-level' }, { n: 3, start_s: 7, end_s: 10.5, size: 'wide', angle: 'overhead' }, { n: 4, start_s: 10.5, end_s: 14, size: 'close', angle: 'eye-level' }] } as any

it('same person compares each frame with the earliest frame from the same camera angle (review M6)', async () => {
  passAll(); bd.mockReset(); bd.mockResolvedValue(angled)
  const r = await compareToReference({ url: 'https://www.instagram.com/p/x/' }, 'remake-file', ctx)
  const sp = gate.mock.calls.filter((c) => String(c[1]).startsWith('same-person')).map((c) => [c[1], (c[2] as any).reference.data, (c[2] as any).frames.map((f: any) => f.data)])
  expect(sp).toEqual([
    ['same-person@1.75', '/m/remake.mp4@1.75', ['/m/remake.mp4@5.25', '/m/remake.mp4@8.75']],
    ['same-person@5.25', '/m/remake.mp4@5.25', ['/m/remake.mp4@12.25']],
  ])
  expect(r.checks.filter((c) => c.name === 'same-person')).toHaveLength(1)
})

it('expression is judged on face close-ups as well as the whole frame (review M6)', async () => {
  passAll(); bd.mockReset(); bd.mockResolvedValue(angled); sample.mockClear()
  await compareToReference({ url: 'https://www.instagram.com/p/x/' }, 'remake-file', ctx)
  expect(sample.mock.calls.some((c) => Array.isArray(c[3]))).toBe(true)
  const ex = gate.mock.calls.find((c) => c[1] === 'expression@1.75')![2] as any
  expect(ex.referenceFace.data).toBe('face:/m/ref.mp4@1.75')
  expect(ex.frameFace.data).toBe('face:/m/remake.mp4@1.75')
})

it('a check that does not pass carries a side-by-side evidence image (review M8)', async () => {
  passAll(); bd.mockReset(); bd.mockResolvedValue(angled); upload.mockClear()
  gate.mockImplementation(async (_s: unknown, name: string) => ({ name, status: name === 'expression@5.25' ? 'fail' : 'pass', reason: '', evidenceTimes: [5.25] }))
  const r = await compareToReference({ url: 'https://www.instagram.com/p/x/' }, 'remake-file', ctx)
  expect(r.checks.find((c) => c.name === 'expression@5.25')?.evidenceFileIds).toEqual(['ev1'])
  expect(r.checks.find((c) => c.name === 'expression@1.75')?.evidenceFileIds).toBeUndefined()
  expect(upload).toHaveBeenCalledTimes(1)
})
