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

import { assembleClips, inputSchema, chooseFrameRate, parseRate } from './assembleClips.js'
import { uploadGeneratedFile } from '../../persistence.js'

function ctx(values: Record<string, string>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext, agent: { toolCallId: 'call-1' } } as never
}
const baseCtx = () => ctx({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })
const ffmpegCall = () => execFile.mock.calls.find((c) => c[0] === 'ffmpeg')! as unknown as [string, string[]]

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

  it('rejects a 13th clip id', () => {
    // Parsed off the exported raw Zod schema, not assembleClips.inputSchema —
    // createTool's wrapped type is StandardSchemaWithJSON, which has no
    // .safeParse (this exact omission broke type-check in an earlier task).
    const result = inputSchema.safeParse({
      clipFileIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'],
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

  it('lays the narration under the joined video when audioFileId is set, so the result already has sound', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'assembled1', name: 'assembled.mp4', type: 'video/mp4', size: 8 })

    await assembleClips.execute!({ clipFileIds: ['c1', 'c2'], targetDurationSeconds: 12, aspectRatio: '9:16', audioFileId: 'narration1' } as never, baseCtx())

    const args = ffmpegCall()[1] as string[]
    expect(args.filter((a) => a === '-i')).toHaveLength(3)
    expect(args).not.toContain('-an')
    expect(args[args.indexOf('-map', args.indexOf('[outv]')) + 1]).toBe('2:a:0')
    expect(args).toContain('-c:a')
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
    const args = ffmpegCall()[1] as string[]
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
    const args = ffmpegCall()[1] as string[]
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
    const args = ffmpegCall()[1] as string[]
    expect(args).toContain('-an')
  })

  it('returns a distinct MISSING_AUDIO_STREAM refusal when preserveAudio is true and a clip has no audio track', async () => {
    // Real ffmpeg (8.1.2, confirmed live) fails filtergraph binding with
    // "Stream specifier ':a' in filtergraph description ... matches no
    // streams" when an [i:a] label has no audio stream to bind to.
    // Matched on cmd, not call position — assembleClips now ffprobes every
    // clip's frame rate before this call, so the ffmpeg invocation is no
    // longer necessarily the first execFile call.
    execFile.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: (err: (Error & { stderr?: string }) | null, res?: { stdout: string; stderr: string }) => void) => {
      if (cmd === 'ffmpeg') {
        const err = new Error('Command failed') as Error & { stderr?: string }
        err.stderr = "[fc#0] Stream specifier ':a' in filtergraph description [0:v]...[0:a]... matches no streams."
        return cb(err)
      }
      cb(null, { stdout: '', stderr: '' })
    })
    getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-1000', expires_at: null }] }) })

    const result = await assembleClips.execute!({ clipFileIds: ['c1', 'c2'], preserveAudio: true, aspectRatio: '9:16' } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: 'MISSING_AUDIO_STREAM' })
  })

  it('refunds the charge when ffmpeg fails after a successful charge', async () => {
    // Matched on cmd, not call position — see note above.
    execFile.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void) => {
      if (cmd === 'ffmpeg') return cb(new Error('ffmpeg exploded'))
      cb(null, { stdout: '', stderr: '' })
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
    // assembleClips now ffprobes every clip's frame rate before charging
    // (A1) — local, cost-free, so it's no longer gated on the charge
    // succeeding. ffmpeg itself must still never run.
    expect(execFile.mock.calls.map((c) => c[0])).not.toContain('ffmpeg')
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

  it('rejects an xfade entry with a name outside the fixed transition enum (filter-graph injection guard)', () => {
    // `name` is interpolated unvalidated into the ffmpeg -filter_complex
    // string (xfade=transition=${name}:...). A free-form string here is a
    // real local-file-read primitive: a payload like
    // "fade[zz]; movie=red.mp4,fps=30,...[inj]; [zz][inj]xfade=..." closes
    // the intended filter early and injects a second filter chain that
    // reads an arbitrary local file via ffmpeg's movie= source. `name`
    // must be constrained to a fixed enum of real ffmpeg xfade transition
    // names, not merely a non-empty string.
    const result = inputSchema.safeParse({
      clipFileIds: ['a', 'b'],
      aspectRatio: '9:16',
      preserveAudio: true,
      transitions: [{
        type: 'xfade',
        name: 'fade[zz]; movie=red.mp4,fps=30,scale=1080:1920[inj]; [zz][inj]xfade=transition=fadeblack',
        overlapSeconds: 1,
      }],
    })
    expect(result.success).toBe(false)
  })

  it('builds a sequential xfade/acrossfade+concat filter graph when transitions is set (xfade then cut)', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'assembled1', name: 'assembled.mp4', type: 'video/mp4', size: 8 })
    // Matched by content, not call position: assembleClips now ffprobes
    // every clip's frame rate (JSON, A1) before the transitions branch's
    // own per-clip video-stream-duration ffprobe (plain csv), so the two
    // probe kinds interleave with the ffmpeg call in a fixed order that
    // ordered mockImplementationOnce calls can no longer assume.
    execFile.mockImplementation((cmd: string, args: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
      if (cmd === 'ffprobe' && args.includes('json')) return cb(null, { stdout: '', stderr: '' })
      if (cmd === 'ffprobe') return cb(null, { stdout: '3.0', stderr: '' })
      cb(null, { stdout: '', stderr: '' })
    })

    await assembleClips.execute!({
      clipFileIds: ['c1', 'c2', 'c3'],
      aspectRatio: '9:16',
      preserveAudio: true,
      transitions: [
        { type: 'xfade', name: 'fade', overlapSeconds: 1 },
        { type: 'cut' },
      ],
    } as never, baseCtx())

    const args = ffmpegCall()[1]
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
    // Matched by content, not call position — see note in the test above.
    execFile.mockImplementation((cmd: string, args: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
      if (cmd === 'ffprobe' && args.includes('json')) return cb(null, { stdout: '', stderr: '' })
      if (cmd === 'ffprobe') return cb(null, { stdout: '3.0', stderr: '' })
      cb(null, { stdout: '', stderr: '' })
    })

    await assembleClips.execute!({
      clipFileIds: ['c1', 'c2', 'c3'],
      aspectRatio: '9:16',
      preserveAudio: true,
      transitions: [
        { type: 'cut' },
        { type: 'xfade', name: 'fade', overlapSeconds: 1 },
      ],
    } as never, baseCtx())

    const args = ffmpegCall()[1]
    const filterComplex = args[args.indexOf('-filter_complex') + 1]
    // Tightened beyond two independent toContain checks: asserts the
    // settb'd label is the SAME one the following xfade actually reads
    // from (concat's raw video output -> settb -> the label xfade's
    // first input names), not merely that both substrings appear
    // somewhere in the graph. A regression where settb lands on the
    // wrong label, or feeds the final concat instead of the intermediate
    // one, would still pass two separate toContain assertions but not
    // this chained one — and that's exactly the bug class (exit 234,
    // zero output) this test exists to catch.
    // accDuration after the cut boundary is 3+3=6, so the xfade offset
    // is 6-1=5.
    expect(filterComplex).toMatch(/\[accv0raw\]\[acca0\]; \[accv0raw\]settb=1\/30\[accv0\]; \[accv0\]\[v2\]xfade=transition=fade:duration=1:offset=5\[outv\]/)
  })

  it('refuses with INVALID_TRANSITION_OVERLAP when overlapSeconds exceeds the accumulated clip duration, before ever calling ffmpeg', async () => {
    // buildTransitionsFilterComplex's negative-offset guard: an xfade
    // overlapSeconds larger than the accumulated stream it would
    // crossfade against produces a negative `offset`, which real ffmpeg
    // accepts silently and turns into a garbled result rather than an
    // error — so this must be caught before ffmpeg ever runs, not
    // discovered via a live ffmpeg failure.
    // Matched by content, not call position — see note above.
    execFile.mockImplementation((cmd: string, args: string[], _o: unknown, cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
      if (cmd === 'ffprobe' && args.includes('json')) return cb(null, { stdout: '', stderr: '' })
      cb(null, { stdout: '3.0', stderr: '' })
    })
    getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-1000', expires_at: null }] }) })

    const result = await assembleClips.execute!({
      clipFileIds: ['c1', 'c2'],
      aspectRatio: '9:16',
      preserveAudio: true,
      // Two 3s clips (accDuration for the first boundary is 3), overlap
      // 5 > 3 -> offset = 3 - 5 = -2.
      transitions: [{ type: 'xfade', name: 'fade', overlapSeconds: 5 }],
    } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: 'INVALID_TRANSITION_OVERLAP' })
    // Only ffprobe calls should have run — the guard must throw before the
    // ffmpeg execFile call is ever made.
    expect(execFile).not.toHaveBeenCalledWith('ffmpeg', expect.anything(), expect.anything(), expect.anything())
    const commands = execFile.mock.calls.map(c => c[0])
    expect(commands).not.toContain('ffmpeg')
    expect(commands.every(c => c === 'ffprobe')).toBe(true)
  })

  it('returns a distinct XFADE_FILTER_FAILED refusal when ffmpeg fails with the real invalid-transition-name error text', async () => {
    // Real ffmpeg (8.1.2, confirmed live against an actual invalid
    // `transition` name, not guessed) fails option-binding with "Error
    // applying option 'transition' to filter 'xfade': Not yet implemented
    // in FFmpeg, patches welcome" (exit 176) — mirrors the
    // MISSING_AUDIO_STREAM test's structure above.
    //
    // `name` here is a valid enum value ('fade') — a real bad transition
    // name can no longer reach ffmpeg at all now that `name` is schema-
    // constrained to a fixed enum (the filter-graph-injection fix). This
    // test instead verifies the catch-branch's stderr-matching logic in
    // isolation (defense in depth for any other real ffmpeg xfade
    // failure that produces this exact error text) by mocking the ffmpeg
    // call to fail with the real captured stderr directly.
    // Matched by content, not call position — see note above.
    execFile.mockImplementation((cmd: string, args: string[], _o: unknown, cb: (e: (Error & { stderr?: string }) | null, r?: { stdout: string; stderr: string }) => void) => {
      if (cmd === 'ffprobe' && args.includes('json')) return cb(null, { stdout: '', stderr: '' })
      if (cmd === 'ffprobe') return cb(null, { stdout: '3.0', stderr: '' })
      const err = new Error('Command failed') as Error & { stderr?: string }
      err.stderr = "[Parsed_xfade_0] const_values array too small for transition\nError applying option 'transition' to filter 'xfade': Not yet implemented in FFmpeg, patches welcome"
      cb(err)
    })
    getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-1000', expires_at: null }] }) })

    const result = await assembleClips.execute!({
      clipFileIds: ['c1', 'c2'],
      aspectRatio: '9:16',
      preserveAudio: true,
      transitions: [{ type: 'xfade', name: 'fade', overlapSeconds: 1 }],
    } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: 'XFADE_FILTER_FAILED' })
  })
})

describe('frame rate (A1)', () => {
  it('parses ffprobe rates', () => {
    expect(parseRate('24/1')).toBe(24)
    expect(parseRate('30000/1001')).toBeCloseTo(29.97, 2)
    expect(parseRate(undefined)).toBeNaN()
    expect(parseRate('0/0')).toBeNaN()
  })
  it('keeps a shared rate and never upsamples 24 to 30', () => {
    expect(chooseFrameRate([24, 24, 24])).toBe(24)
    expect(chooseFrameRate([24, 24, 30])).toBe(24)
    expect(chooseFrameRate([30, 30, 24])).toBe(30)
  })
  it('falls back to 30 when no rate could be read', () => {
    expect(chooseFrameRate([NaN, NaN])).toBe(30)
    expect(chooseFrameRate([])).toBe(30)
  })
})

describe('assembleClips probe, fades and length check (A1–A3)', () => {
  const probeJson = (fps: string, dur: string) => JSON.stringify({ streams: [{ codec_type: 'video', r_frame_rate: fps, duration: dur }, { codec_type: 'audio', duration: dur }] })

  it('uses the clips own 24fps, resets timestamps and fades audio at every cut', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'a1', name: 'a.mp4', type: 'video/mp4', size: 8 })
    execFile.mockImplementation((cmd: string, args: string[], _o: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
      if (cmd === 'ffprobe' && args.includes('format=duration')) return cb(null, { stdout: '4.000\n', stderr: '' })
      if (cmd === 'ffprobe') return cb(null, { stdout: probeJson('24/1', '2.000'), stderr: '' })
      cb(null, { stdout: '', stderr: '' })
    })

    const result = await assembleClips.execute!({ clipFileIds: ['c1', 'c2'], preserveAudio: true, aspectRatio: '16:9' } as never, baseCtx())

    const graph = ffmpegCall()[1][ffmpegCall()[1].indexOf('-filter_complex') + 1]
    expect(graph).toContain('fps=24')
    expect(graph).not.toContain('fps=30')
    expect(graph).toContain('setpts=PTS-STARTPTS')
    expect(graph).toContain('asetpts=PTS-STARTPTS')
    expect(graph).toContain('afade=t=in:d=0.04')
    expect(graph).toContain('afade=t=out:st=1.96:d=0.04')
    expect(result).toMatchObject({ fileId: 'a1', fps: 24 })
  })

  it('refuses DURATION_MISMATCH and refunds when the output length is off by more than 0.1s', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-1000', expires_at: null }] }) })
    execFile.mockImplementation((cmd: string, args: string[], _o: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
      if (cmd === 'ffprobe' && args.includes('format=duration')) return cb(null, { stdout: '5.20\n', stderr: '' })
      if (cmd === 'ffprobe') return cb(null, { stdout: probeJson('24/1', '2.000'), stderr: '' })
      cb(null, { stdout: '', stderr: '' })
    })

    const result = await assembleClips.execute!({ clipFileIds: ['c1', 'c2'], preserveAudio: true, aspectRatio: '16:9' } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^DURATION_MISMATCH/) })
    expect(spendCredits).toHaveBeenCalledWith(expect.objectContaining({ kind: 'refund' }))
  })

  it('probe garbage falls back to 30fps and skips the length check (never refuses a valid join)', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'a2', name: 'a.mp4', type: 'video/mp4', size: 8 })
    const result = await assembleClips.execute!({ clipFileIds: ['c1', 'c2'], preserveAudio: true, aspectRatio: '16:9' } as never, baseCtx())
    const graph = ffmpegCall()[1][ffmpegCall()[1].indexOf('-filter_complex') + 1]
    expect(graph).toContain('fps=30')
    expect(result).toMatchObject({ fileId: 'a2' })
  })

  it('lays a continuous room tone under the joined audio when roomTone is set', async () => {
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'a3', name: 'a.mp4', type: 'video/mp4', size: 8 })
    await assembleClips.execute!({ clipFileIds: ['c1', 'c2'], preserveAudio: true, roomTone: true, aspectRatio: '16:9' } as never, baseCtx())
    const args = ffmpegCall()[1]
    expect(args.join(' ')).toContain('anoisesrc=color=brown')
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('lowpass=f=700')
  })
})
