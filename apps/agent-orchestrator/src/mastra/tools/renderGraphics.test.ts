import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { spendCredits, resolveRate, isUnlimited, getPool } = vi.hoisted(() => ({
  spendCredits: vi.fn(), resolveRate: vi.fn(), isUnlimited: vi.fn(), getPool: vi.fn(),
}))
vi.mock('@serverless-saas/credits', () => ({
  spendCredits, resolveRate, isUnlimited,
  costMicro: (schema: { per_call_micro?: number }, usage: { count?: number }) =>
    BigInt(schema.per_call_micro ?? 0) * BigInt(usage.count ?? 0),
}))
vi.mock('../../usage.js', () => ({ getPool }))
vi.mock('../../persistence.js', () => ({ uploadGeneratedFile: vi.fn() }))
const { fetchPresignedUrl, downloadToSessionCache } = vi.hoisted(() => ({
  fetchPresignedUrl: vi.fn(), downloadToSessionCache: vi.fn(),
}))
vi.mock('./mediaCache.js', () => ({ fetchPresignedUrl, downloadToSessionCache }))
const { shouldRequireApproval } = vi.hoisted(() => ({ shouldRequireApproval: vi.fn() }))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval }))
const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), writeFileSync: vi.fn() }
})

import { renderGraphics, inputSchema } from './renderGraphics.js'
import { uploadGeneratedFile } from '../../persistence.js'

function ctx(values: Record<string, string>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext, agent: { toolCallId: 'call-1' } } as never
}
const baseCtx = () => ctx({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })

const PROBE_JSON = JSON.stringify({ streams: [{ r_frame_rate: '30/1', duration: '5.0' }] })

beforeEach(() => {
  vi.resetAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 1_000 } })
  shouldRequireApproval.mockResolvedValue(false)
  fetchPresignedUrl.mockImplementation(async (fileId: string) => `https://cdn.example/${fileId}`)
  downloadToSessionCache.mockImplementation(async (_scope: string, fileId: string) => ({
    filePath: `/tmp/${fileId}.mp4`, buf: Buffer.from('x'), mimeType: 'video/mp4',
  }))
  execFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, res: { stdout: string; stderr: string }) => void) => {
    if (cmd === 'ffprobe') cb(null, { stdout: PROBE_JSON, stderr: '' })
    else cb(null, { stdout: '', stderr: '' })
  })
})

describe('renderGraphics input schema', () => {
  it('accepts a well-formed title_card element', () => {
    const res = inputSchema.safeParse({
      videoFileId: 'v1', aspectRatio: '16:9',
      elements: [{ type: 'title_card', startSeconds: 0, endSeconds: 3, name: 'Disha', role: 'Consular Assistant' }],
    })
    expect(res.success).toBe(true)
  })

  it('rejects an element whose endSeconds does not exceed startSeconds', () => {
    const res = inputSchema.safeParse({
      videoFileId: 'v1', aspectRatio: '16:9',
      elements: [{ type: 'corner_mark', startSeconds: 3, endSeconds: 3 }],
    })
    expect(res.success).toBe(false)
  })

  it('rejects a screen_walkthrough zoomTo above the 1.4 hard clamp', () => {
    const res = inputSchema.safeParse({
      videoFileId: 'v1', aspectRatio: '16:9',
      elements: [{ type: 'screen_walkthrough', startSeconds: 0, endSeconds: 3, screenshotFileId: 's1', zoomTo: 1.7 }],
    })
    expect(res.success).toBe(false)
  })

  it('rejects an unknown element type', () => {
    const res = inputSchema.safeParse({
      videoFileId: 'v1', aspectRatio: '16:9',
      elements: [{ type: 'lower_third', startSeconds: 0, endSeconds: 3 }],
    })
    expect(res.success).toBe(false)
  })
})

describe('renderGraphics tool', () => {
  it('runs remotion render then ffmpeg overlay, computing frame padding from the probed duration/fps, and uploads the result', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    vi.mocked(uploadGeneratedFile).mockResolvedValue({ fileId: 'f1', name: 'Graphics Pass', type: 'video/mp4', size: 9 } as never)

    const result = await renderGraphics.execute!({
      videoFileId: 'video1', aspectRatio: '16:9',
      elements: [{ type: 'corner_mark', startSeconds: 0, endSeconds: 5 }],
    } as never, baseCtx())

    const remotionCall = execFile.mock.calls.find((c) => c[0] === 'npx')
    expect(remotionCall).toBeTruthy()
    expect(remotionCall![1]).toEqual(expect.arrayContaining(['remotion', 'render', 'src/index.ts', 'GraphicsOverlay']))

    // 5s at 30fps = 150 frames, max index 149 -> 3-digit padding, matching
    // the live-verified Remotion naming behaviour (see renderGraphics.ts's
    // comment on this computation).
    const ffmpegCall = execFile.mock.calls.find((c) => c[0] === 'ffmpeg' && (c[1] as string[]).includes('-filter_complex'))
    expect(ffmpegCall).toBeTruthy()
    const framePatternArg = (ffmpegCall![1] as string[]).find((a) => a.includes('element-%0'))
    expect(framePatternArg).toContain('element-%03d.png')

    expect(spendCredits).toHaveBeenCalled()
    expect(result).toMatchObject({ fileId: 'f1' })
  })

  it('refunds the charge when the Remotion render fails', async () => {
    execFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, res: { stdout: string; stderr: string }) => void) => {
      if (cmd === 'ffprobe') return cb(null, { stdout: PROBE_JSON, stderr: '' })
      if (cmd === 'npx') return cb(new Error('remotion render crashed'), { stdout: '', stderr: '' })
      cb(null, { stdout: '', stderr: '' })
    })
    getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-1000', expires_at: null }] }) })

    const result = await renderGraphics.execute!({
      videoFileId: 'video1', aspectRatio: '16:9',
      elements: [{ type: 'corner_mark', startSeconds: 0, endSeconds: 5 }],
    } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: 'RENDER_FAILED' })
    expect(spendCredits).toHaveBeenCalledTimes(2) // charge, then refund
  })
})
