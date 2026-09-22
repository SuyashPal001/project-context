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

  it('accepts 4 clip ids (raised from the old max of 3 in skill 5)', () => {
    const result = inputSchema.safeParse({
      clipFileIds: ['a', 'b', 'c', 'd'],
      aspectRatio: '9:16',
    })
    expect(result.success).toBe(true)
  })

  it('accepts 8 clip ids (raised from 4 in skill 7 for short-drama-stitch)', () => {
    const result = inputSchema.safeParse({
      clipFileIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      aspectRatio: '9:16',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a 9th clip id', () => {
    // Parsed off the exported raw Zod schema, not assembleClips.inputSchema —
    // createTool's wrapped type is StandardSchemaWithJSON, which has no
    // .safeParse (this exact omission broke type-check in an earlier task).
    const result = inputSchema.safeParse({
      clipFileIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
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

  it('accepts a valid transitions array matching clipFileIds.length - 1', () => {
    const result = inputSchema.safeParse({
      clipFileIds: ['a', 'b', 'c'],
      aspectRatio: '9:16',
      preserveAudio: true,
      transitions: [
        { type: 'xfade', name: 'fade', overlapSeconds: 1 },
        { type: 'cut' },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('rejects transitions with the wrong length', () => {
    const result = inputSchema.safeParse({
      clipFileIds: ['a', 'b', 'c'],
      aspectRatio: '9:16',
      preserveAudio: true,
      transitions: [{ type: 'cut' }],
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('TRANSITION_COUNT_MISMATCH')
  })

  it('rejects transitions set without preserveAudio', () => {
    const result = inputSchema.safeParse({
      clipFileIds: ['a', 'b'],
      aspectRatio: '9:16',
      transitions: [{ type: 'cut' }],
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('TRANSITION_REQUIRES_AUDIO')
  })

  it('rejects an xfade entry with overlapSeconds: 0', () => {
    // Negative control for the live-verified ffmpeg bug: video xfade
    // duration=0 silently drops the second clip entirely; audio acrossfade
    // d=0 falls through to a ~0.92s default. Neither is a valid "zero-width
    // crossfade," so the schema must reject this before it reaches ffmpeg.
    const result = inputSchema.safeParse({
      clipFileIds: ['a', 'b'],
      aspectRatio: '9:16',
      preserveAudio: true,
      transitions: [{ type: 'xfade', name: 'fade', overlapSeconds: 0 }],
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('INVALID_TRANSITION_OVERLAP')
  })

  it('rejects an xfade entry with overlapSeconds omitted', () => {
    const result = inputSchema.safeParse({
      clipFileIds: ['a', 'b'],
      aspectRatio: '9:16',
      preserveAudio: true,
      transitions: [{ type: 'xfade', name: 'fade' }],
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('INVALID_TRANSITION_OVERLAP')
  })

  it('rejects an xfade entry with no name', () => {
    const result = inputSchema.safeParse({
      clipFileIds: ['a', 'b'],
      aspectRatio: '9:16',
      preserveAudio: true,
      transitions: [{ type: 'xfade', overlapSeconds: 1 }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a cut entry that carries overlapSeconds', () => {
    const result = inputSchema.safeParse({
      clipFileIds: ['a', 'b'],
      aspectRatio: '9:16',
      preserveAudio: true,
      transitions: [{ type: 'cut', overlapSeconds: 1 }],
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(JSON.stringify(result.error.issues)).toContain('INVALID_TRANSITION_OVERLAP')
  })

  it('builds a sequential xfade/acrossfade+concat filter graph when transitions is set (xfade then cut)', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'assembled1', name: 'assembled.mp4', type: 'video/mp4', size: 8 })
    // Three ffprobe duration calls (one per input, 3s each), then the ffmpeg
    // call itself.
    execFile
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '3.0', stderr: '' }))
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '3.0', stderr: '' }))
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '3.0', stderr: '' }))
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '', stderr: '' }))

    await assembleClips.execute!({
      clipFileIds: ['c1', 'c2', 'c3'],
      aspectRatio: '9:16',
      preserveAudio: true,
      transitions: [
        { type: 'xfade', name: 'fade', overlapSeconds: 1 },
        { type: 'cut' },
      ],
    } as never, baseCtx())

    const ffmpegCall = execFile.mock.calls.find(c => c[0] === 'ffmpeg')!
    const args = ffmpegCall[1] as string[]
    const filterComplex = args[args.indexOf('-filter_complex') + 1]
    // Matches the spec's live-verified confirmed-correct shape exactly:
    // offset = accumulated duration so far (3) - overlap (1) = 2.
    expect(filterComplex).toContain('xfade=transition=fade:duration=1:offset=2')
    expect(filterComplex).toContain('acrossfade=d=1')
    expect(filterComplex).toMatch(/concat=n=2:v=1:a=1\[outv\]\[outa\]/)
  })

  it('inserts settb after a concat that feeds a LATER xfade (cut-then-xfade ordering)', async () => {
    // This ordering is the one the plan's Opus review found ffmpeg rejects
    // without a fix: feeding a concat filter's video output directly into a
    // later xfade fails live with "First input link main timebase ...
    // do not match ... xfade timebase" and produces NO output file (exit
    // 234) — the earlier xfade-then-cut test above never exercises this
    // path, since its concat is the LAST boundary. This test asserts the
    // settb fix is present: the video output of a non-final concat must be
    // re-based to 1/30 before it feeds the next xfade.
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'assembled1', name: 'assembled.mp4', type: 'video/mp4', size: 8 })
    execFile
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '3.0', stderr: '' }))
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '3.0', stderr: '' }))
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '3.0', stderr: '' }))
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '', stderr: '' }))

    await assembleClips.execute!({
      clipFileIds: ['c1', 'c2', 'c3'],
      aspectRatio: '9:16',
      preserveAudio: true,
      transitions: [
        { type: 'cut' },
        { type: 'xfade', name: 'fade', overlapSeconds: 1 },
      ],
    } as never, baseCtx())

    const ffmpegCall = execFile.mock.calls.find(c => c[0] === 'ffmpeg')!
    const args = ffmpegCall[1] as string[]
    const filterComplex = args[args.indexOf('-filter_complex') + 1]
    expect(filterComplex).toContain('concat=n=2:v=1:a=1')
    expect(filterComplex).toContain('settb=1/30')
  })

  it('returns a distinct XFADE_FILTER_FAILED refusal on a real invalid-transition-name ffmpeg failure', async () => {
    // Real ffmpeg (8.1.2, confirmed live against an actual invalid
    // `transition` name, not guessed) fails option-binding with "Error
    // applying option 'transition' to filter 'xfade': Not yet implemented
    // in FFmpeg, patches welcome" (exit 176) — mirrors the
    // MISSING_AUDIO_STREAM test's structure above.
    execFile
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '3.0', stderr: '' }))
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => cb(null, { stdout: '3.0', stderr: '' }))
      .mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: Error & { stderr?: string }) => void) => {
        const err = new Error('Command failed') as Error & { stderr?: string }
        err.stderr = "[Parsed_xfade_0] const_values array too small for transition\nError applying option 'transition' to filter 'xfade': Not yet implemented in FFmpeg, patches welcome"
        cb(err)
      })
    getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-1000', expires_at: null }] }) })

    const result = await assembleClips.execute!({
      clipFileIds: ['c1', 'c2'],
      aspectRatio: '9:16',
      preserveAudio: true,
      transitions: [{ type: 'xfade', name: 'not-a-real-name', overlapSeconds: 1 }],
    } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: 'XFADE_FILTER_FAILED' })
  })
})
