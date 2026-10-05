import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

vi.mock('../cost.js', () => ({ persistCost: vi.fn() }))
vi.mock('./avatarReferences.js', () => ({ resolveAvatarReferences: vi.fn(async () => ({ fileIds: [] })) }))
vi.mock('./oneVideoPerTurn.js', () => ({ markCheckFailed: vi.fn() }))
vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl: vi.fn(async (id: string) => `https://s3.example/${id}`) }))
const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile }))
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(() => Buffer.from('jpg')), writeFileSync: vi.fn() }
})
const { runNarrowClipChecks } = vi.hoisted(() => ({ runNarrowClipChecks: vi.fn() }))
vi.mock('./tvcChecks.js', async (orig) => {
  const actual = await orig<typeof import('./tvcChecks.js')>()
  return { ...actual, runNarrowClipChecks, gatewayAsk: () => async () => ({}) }
})

import { checkClip } from './checkClip.js'
import { CheckUnavailableError } from './tvcChecks.js'

function ctx() {
  const rc = new RequestContext()
  for (const [k, v] of Object.entries({ tenantId: 't1', conversationId: 'c-narrow', idToken: 'tok' })) rc.set(k, v)
  return { requestContext: rc, agent: { toolCallId: 'x', messages: [] } } as never
}

beforeEach(() => {
  vi.resetAllMocks()
  execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '3.0\n', stderr: '' }))
  global.fetch = vi.fn(async (url: string) => {
    if (String(url).includes('/v1/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"scene_same":true,"glitch":false,"confidence":9,"differences":"none","heard":""}' } }] }), { status: 200 })
    }
    return new Response(Buffer.from('bytes'), { status: 200, headers: { 'content-type': String(url).includes('clip') ? 'video/mp4' : 'image/jpeg' } })
  }) as unknown as typeof fetch
})

describe('check_clip narrow checks', () => {
  it('fails the clip when a narrow check fails, and returns the trim window', async () => {
    runNarrowClipChecks.mockResolvedValue({ passed: false, reasons: ['ACTION_NOT_COMPLETED: "the bottle has no cap" is not true at the end.'], glitchFree: true, actionHappened: true, actionTime: 1.34, endStateTrue: false, trimStartSeconds: 0.99 })
    const r = await checkClip.execute!({ clipFileId: 'clip1', masterStillFileId: 'still1', noPerson: true, expectNoSpeech: false, action: 'cap pops off', endState: 'the bottle has no cap', shotDurationSeconds: 0.88 } as never, ctx())
    expect(r).toMatchObject({ passed: false, endStateTrue: false, trimStartSeconds: 0.99, reason: expect.stringMatching(/ACTION_NOT_COMPLETED/) })
  })
  it('reports CHECK_UNAVAILABLE (never a pass) when the Pro check cannot run', async () => {
    runNarrowClipChecks.mockRejectedValue(new CheckUnavailableError('check unavailable: gateway 500'))
    const r = await checkClip.execute!({ clipFileId: 'clip2', masterStillFileId: 'still1', noPerson: true, productScale: 'close', productFileId: 'prod1' } as never, ctx())
    expect(r).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^CHECK_UNAVAILABLE/) })
  })
  it('a legacy call never calls the narrow checks', async () => {
    await checkClip.execute!({ clipFileId: 'clip3', masterStillFileId: 'still1', noPerson: true } as never, ctx())
    expect(runNarrowClipChecks).not.toHaveBeenCalled()
  })
  it('treats a plain Error thrown by the frame sampler as CHECK_UNAVAILABLE, never a pass and never an uncaught crash', async () => {
    // sampleFrames shells out to ffmpeg; a plain execFile/ffmpeg failure is not
    // a CheckUnavailableError, but must still be refused as unchecked.
    runNarrowClipChecks.mockImplementation(async (_ask: unknown, sample: (times: number[]) => Promise<unknown>) => {
      await sample([1, 2, 3])
      return { passed: true, reasons: [], glitchFree: true }
    })
    // check_clip's own frame extraction (ffmpeg) runs before the narrow
    // checks and must still succeed; only the narrow check's own sampling
    // (the 4th+ ffmpeg call) fails, pinning that the failure comes from
    // sampleFrames and not from the main check.
    let ffmpegCalls = 0
    execFile.mockImplementation((cmd: string, _a: string[], _o: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
      if (cmd === 'ffmpeg') {
        ffmpegCalls++
        if (ffmpegCalls > 3) return cb(new Error('ffmpeg: no such filter'), { stdout: '', stderr: '' })
        return cb(null, { stdout: '', stderr: '' })
      }
      cb(null, { stdout: '3.0\n', stderr: '' })
    })
    await expect(checkClip.execute!({ clipFileId: 'clip4', masterStillFileId: 'still1', noPerson: true, action: 'cap pops off' } as never, ctx())).resolves.toMatchObject({
      refused: true, refusalReason: expect.stringMatching(/^CHECK_UNAVAILABLE/),
    })
  })
})
