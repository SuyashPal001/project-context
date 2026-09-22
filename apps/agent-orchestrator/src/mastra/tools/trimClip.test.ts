import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { inputSchema } from './trimClip.js'

describe('trimClip inputSchema', () => {
  it('accepts a valid trim range', () => {
    const result = inputSchema.safeParse({ sourceFileId: 'c1', startSeconds: 2, endSeconds: 5 })
    expect(result.success).toBe(true)
  })

  it('rejects endSeconds <= startSeconds', () => {
    const result = inputSchema.safeParse({ sourceFileId: 'c1', startSeconds: 5, endSeconds: 5 })
    expect(result.success).toBe(false)
  })

  it('rejects a negative startSeconds', () => {
    const result = inputSchema.safeParse({ sourceFileId: 'c1', startSeconds: -1, endSeconds: 5 })
    expect(result.success).toBe(false)
  })
})

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
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

import { trimClip } from './trimClip.js'
import { uploadGeneratedFile } from '../../persistence.js'

function ctx(values: Record<string, string>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext, agent: { toolCallId: 'call-1' } } as never
}
const baseCtx = () => ctx({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })

function probeResult(durationSeconds: string, hasAudio: boolean) {
  return {
    stdout: JSON.stringify({
      format: { duration: durationSeconds },
      streams: hasAudio ? [{ codec_type: 'video' }, { codec_type: 'audio' }] : [{ codec_type: 'video' }],
    }),
    stderr: '',
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 1_000 } })
  shouldRequireApproval.mockResolvedValue(false)
  fetchPresignedUrl.mockImplementation(async (fileId: string) => `https://cdn.example/${fileId}`)
  downloadToSessionCache.mockImplementation(async (_scope: string, fileId: string) => ({
    filePath: `/tmp/${fileId}.mp4`, buf: Buffer.from('x'), mimeType: 'video/mp4',
  }))
  execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, res: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: '', stderr: '' })
  })
})

describe('trimClip execute', () => {
  it('downloads the source, probes duration+audio, trims with ffmpeg, and uploads the result', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'trimmed1', name: 'trimmed.mp4', type: 'video/mp4', size: 8 })
    execFile
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, probeResult('10.0', true)))
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '', stderr: '' }))

    const result = await trimClip.execute!({ sourceFileId: 'c1', startSeconds: 2, endSeconds: 6 } as never, baseCtx())

    expect(result).toMatchObject({ fileId: 'trimmed1' })
  })

  it('refuses with INVALID_TRIM_RANGE when endSeconds exceeds the probed source duration', async () => {
    execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, probeResult('4.0', true)))

    const result = await trimClip.execute!({ sourceFileId: 'c1', startSeconds: 0, endSeconds: 10 } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: 'INVALID_TRIM_RANGE' })
    // No charge should have happened — the probe runs before charging.
    expect(spendCredits).not.toHaveBeenCalled()
  })

  it('refuses with MISSING_AUDIO_STREAM when the source has no audio track, before charging', async () => {
    execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, probeResult('10.0', false)))

    const result = await trimClip.execute!({ sourceFileId: 'c1', startSeconds: 2, endSeconds: 6 } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: 'MISSING_AUDIO_STREAM' })
    expect(spendCredits).not.toHaveBeenCalled()
  })

  it('refunds the charge when ffmpeg fails after a successful charge', async () => {
    execFile
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, probeResult('10.0', true)))
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: Error) => void) => cb(new Error('ffmpeg exploded')))
    getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-1000', expires_at: null }] }) })

    const result = await trimClip.execute!({ sourceFileId: 'c1', startSeconds: 2, endSeconds: 6 } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: 'TRIM_FAILED' })
    expect(spendCredits).toHaveBeenCalledTimes(2)
    expect(spendCredits).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'refund', jobType: 'clip_assembly' }))
  })

  it('argv-assertion: places -ss and -to AFTER -i (output-side seeking), in that order', async () => {
    // Regression guard for the exact property the trim's correctness
    // depends on — output-side seeking on the requested window, not
    // input-side seeking (faster but can land on the wrong keyframe).
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'trimmed1', name: 'trimmed.mp4', type: 'video/mp4', size: 8 })
    execFile
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, probeResult('10.0', true)))
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '', stderr: '' }))

    await trimClip.execute!({ sourceFileId: 'c1', startSeconds: 2, endSeconds: 6 } as never, baseCtx())

    const ffmpegCall = execFile.mock.calls.find(c => c[0] === 'ffmpeg')!
    const args = ffmpegCall[1] as string[]
    const iIdx = args.indexOf('-i')
    const ssIdx = args.indexOf('-ss')
    const toIdx = args.indexOf('-to')
    expect(ssIdx).toBeGreaterThan(iIdx)
    expect(toIdx).toBeGreaterThan(ssIdx)
    expect(args[ssIdx + 1]).toBe('2')
    expect(args[toIdx + 1]).toBe('6')
  })
})
