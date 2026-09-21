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
// vi.spyOn(fs, 'readFileSync') can't redefine an ESM namespace export
// (Vitest/Node ESM interop rejects it — "Module namespace is not
// configurable"), so readFileSync is wrapped as a vi.fn() at mock-definition
// time instead, same pattern __tests__/media.test.ts uses for mkdtempSync.
// mkdtempSync/rmSync stay real so the tool's actual tempdir lifecycle runs.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

import { assembleClips, inputSchema } from './assembleClips.js'
import { uploadGeneratedFile } from '../../persistence.js'

function ctx(values: Record<string, string>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext, agent: { toolCallId: 'call-1' } } as never
}
const baseCtx = () => ctx({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })

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

describe('assembleClips tool', () => {
  it('downloads every clip, runs ffmpeg, and uploads the concatenated result', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'assembled1', name: 'assembled.mp4', type: 'video/mp4', size: 8 })

    const result = await assembleClips.execute!({ clipFileIds: ['c1', 'c2', 'c3'], aspectRatio: '9:16' } as never, baseCtx())

    expect(downloadToSessionCache).toHaveBeenCalledTimes(3)
    expect(execFile).toHaveBeenCalled()
    expect(result).toMatchObject({ fileId: 'assembled1', name: 'assembled.mp4', fileType: 'video/mp4', size: 8 })
  })

  it('accepts 4 clip ids (raised from the old max of 3)', () => {
    const result = inputSchema.safeParse({
      clipFileIds: ['a', 'b', 'c', 'd'],
      aspectRatio: '9:16',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a 5th clip id', () => {
    // Parsed off the exported raw Zod schema, not assembleClips.inputSchema —
    // createTool's wrapped type is StandardSchemaWithJSON, which has no
    // .safeParse (this exact omission broke type-check in an earlier task).
    const result = inputSchema.safeParse({
      clipFileIds: ['a', 'b', 'c', 'd', 'e'],
      aspectRatio: '9:16',
    })
    expect(result.success).toBe(false)
  })

  it('rejects preserveAudio combined with targetDurationSeconds', () => {
    const result = inputSchema.safeParse({
      clipFileIds: ['a', 'b'],
      aspectRatio: '9:16',
      preserveAudio: true,
      targetDurationSeconds: 20,
    })
    expect(result.success).toBe(false)
  })

  it('rejects a negative targetDurationSeconds at the schema level', () => {
    // Regression guard: a negative value would otherwise reach ffmpeg's -t
    // flag unclamped.
    const parsed = inputSchema.safeParse({ clipFileIds: ['a'], aspectRatio: '9:16', targetDurationSeconds: -5 })
    expect(parsed.success).toBe(false)
  })

  it('refuses with SOURCE_UNAVAILABLE if a clip cannot be downloaded, before running ffmpeg', async () => {
    downloadToSessionCache.mockRejectedValueOnce(new Error('too large'))

    const result = await assembleClips.execute!({ clipFileIds: ['c1'], aspectRatio: '9:16' } as never, baseCtx())

    expect(execFile).not.toHaveBeenCalled()
    expect(result).toMatchObject({ refused: true, refusalReason: 'SOURCE_UNAVAILABLE' })
  })

  it('chains tpad inside filter_complex (not a separate -vf) when targetDurationSeconds is set', async () => {
    // Regression test for the Critical bug found in review: ffmpeg refuses to
    // mix simple (-vf) and complex (-filter_complex) filtering on the same
    // output stream, so a call with targetDurationSeconds set failed 100% of
    // the time — invisible previously because execFile is mocked and nothing
    // asserted on the actual args shape.
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'assembled1', name: 'assembled.mp4', type: 'video/mp4', size: 8 })

    await assembleClips.execute!({ clipFileIds: ['c1', 'c2'], targetDurationSeconds: 10, aspectRatio: '9:16' } as never, baseCtx())

    expect(execFile).toHaveBeenCalled()
    const args = execFile.mock.calls[0][1] as string[]
    expect(args).not.toContain('-vf')
    const filterComplexIdx = args.indexOf('-filter_complex')
    expect(filterComplexIdx).toBeGreaterThanOrEqual(0)
    const filterComplex = args[filterComplexIdx + 1]
    expect(filterComplex).toContain('[cat]')
    expect(filterComplex).toContain('tpad=stop_mode=clone:stop_duration=10')
    expect(filterComplex).toMatch(/concat=n=2:v=1:a=0\[cat\]/)
    expect(filterComplex).toMatch(/\[cat\]tpad=.*\[outv\]/)
    expect(args).toContain('-t')
    expect(args[args.indexOf('-t') + 1]).toBe('10')
  })

  it('builds a v=1:a=1 concat filter with per-input audio normalization and omits -an when preserveAudio is true', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'assembled1', name: 'assembled.mp4', type: 'video/mp4', size: 8 })

    await assembleClips.execute!({ clipFileIds: ['c1', 'c2', 'c3', 'c4'], preserveAudio: true, aspectRatio: '9:16' } as never, baseCtx())

    expect(execFile).toHaveBeenCalled()
    const args = execFile.mock.calls[0][1] as string[]
    const filterComplexIdx = args.indexOf('-filter_complex')
    const filterComplex = args[filterComplexIdx + 1]
    expect(filterComplex).toContain('concat=n=4:v=1:a=1')
    // Every input's audio must be resampled/reformatted to a common shape
    // before concat — concat refuses heterogeneous inputs (this skill's real
    // audio comes from three different sources: fal.ai's lip-synced MP4,
    // our own AAC mux, and an untouched copy from composite_end_card).
    expect(filterComplex).toContain('aresample=48000')
    expect(filterComplex).toContain('channel_layouts=stereo')
    expect(args).not.toContain('-an')
    expect(args).toContain('-map')
    expect(args[args.indexOf('-map') + 1]).toBe('[outv]')
    expect(args).toContain('[outa]')
  })

  it('defaults preserveAudio to false and keeps -an when omitted (skill 4/7 backward compat)', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'assembled1', name: 'assembled.mp4', type: 'video/mp4', size: 8 })

    await assembleClips.execute!({ clipFileIds: ['c1', 'c2'], aspectRatio: '9:16' } as never, baseCtx())

    expect(execFile).toHaveBeenCalled()
    const args = execFile.mock.calls[0][1] as string[]
    expect(args).toContain('-an')
  })

  it('returns a distinct MISSING_AUDIO_STREAM refusal when preserveAudio is true and a clip has no audio track', async () => {
    // Real ffmpeg (8.1.2, confirmed live) fails filtergraph binding with
    // "Stream specifier ':a' in filtergraph description ... matches no
    // streams" when an [i:a] label has no audio stream to bind to.
    execFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error & { stderr?: string }) => void) => {
      const err = new Error('Command failed') as Error & { stderr?: string }
      err.stderr = "[fc#0] Stream specifier ':a' in filtergraph description [0:v]...[0:a]... matches no streams."
      cb(err)
    })
    getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-1000', expires_at: null }] }) })

    const result = await assembleClips.execute!({ clipFileIds: ['c1', 'c2'], preserveAudio: true, aspectRatio: '9:16' } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: 'MISSING_AUDIO_STREAM' })
  })

  it('refunds the charge when ffmpeg fails after a successful charge', async () => {
    execFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      cb(new Error('ffmpeg exploded'))
    })
    getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-1000', expires_at: null }] }) })

    const result = await assembleClips.execute!({ clipFileIds: ['c1'], aspectRatio: '9:16' } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: 'ASSEMBLY_FAILED' })
    expect(spendCredits).toHaveBeenCalledTimes(2)
    expect(spendCredits).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'refund', jobType: 'clip_assembly' }))
  })

  it('does not attempt a refund when the initial charge fails with insufficient credits', async () => {
    class InsufficientCreditsError extends Error { name = 'InsufficientCreditsError' }
    spendCredits.mockRejectedValue(new InsufficientCreditsError('insufficient'))

    const result = await assembleClips.execute!({ clipFileIds: ['c1'], aspectRatio: '9:16' } as never, baseCtx())

    expect(result).toMatchObject({ insufficientCredits: true })
    expect(spendCredits).toHaveBeenCalledTimes(1)
    expect(execFile).not.toHaveBeenCalled()
  })
})
