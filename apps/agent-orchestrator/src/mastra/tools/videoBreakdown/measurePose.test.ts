import { it, expect, vi } from 'vitest'
const ai = vi.fn()
vi.mock('./aiServiceClient.js', () => ({ aiService: (...a: unknown[]) => ai(...a) }))
vi.mock('./fetchVideo.js', () => ({ fetchVideo: vi.fn(async () => ({ filePath: '/m/a.mp4', durationS: 14.9, tooLong: false })) }))
import { measurePoseTool } from './measureTools.js'

const rc = new Map([['idToken', 't'], ['sessionId', 's'], ['tenantId', 'tn']])
const run = (input: unknown) => (measurePoseTool as unknown as { execute: (i: unknown, c: unknown) => Promise<{ success: boolean; result?: any; error?: string }> }).execute(input, { requestContext: { get: (k: string) => rc.get(k) } })

it('measures the looks it is given', async () => {
  ai.mockResolvedValueOnce({ model: 'rtmpose-s', looks: [], moves: [] })
  await run({ url: 'https://www.instagram.com/p/x/', looks: [{ label: 'a', start_s: 0, end_s: 5 }], subject_box: [0.1, 0.1, 0.9, 0.9] })
  expect(ai).toHaveBeenLastCalledWith('/media/pose', expect.objectContaining({ path: '/m/a.mp4', looks: [{ label: 'a', start_s: 0, end_s: 5 }], subject_box: [0.1, 0.1, 0.9, 0.9] }))
})

it('treats the whole video as one look when none are given', async () => {
  ai.mockResolvedValueOnce({ model: 'rtmpose-s', looks: [], moves: [] })
  await run({ url: 'https://www.instagram.com/p/x/' })
  expect(ai.mock.lastCall![1].looks).toEqual([{ label: 'whole video', start_s: 0, end_s: 14.9 }])
})
