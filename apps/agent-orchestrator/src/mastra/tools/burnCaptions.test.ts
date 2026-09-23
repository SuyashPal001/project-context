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
// Same reasoning as assembleClips.test.ts: readFileSync is wrapped as a
// vi.fn() at mock-definition time (ESM namespace exports can't be
// vi.spyOn'd), mkdtempSync/rmSync stay real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

import { inputSchema, groupWordsIntoPhrases, formatSrtTimestamp, buildSrt, burnCaptions } from './burnCaptions.js'

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
  getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [{ amount_micro: '-1000', expires_at: null }] }) })
})

describe('burnCaptions inputSchema', () => {
  it('requires videoFileId and a non-empty words array', () => {
    const ok = inputSchema.safeParse({
      videoFileId: 'v1',
      words: [{ word: 'hi', startSeconds: 0, endSeconds: 0.3 }],
    })
    expect(ok.success).toBe(true)
    const empty = inputSchema.safeParse({ videoFileId: 'v1', words: [] })
    expect(empty.success).toBe(false)
  })
})

describe('groupWordsIntoPhrases', () => {
  it('groups words into phrases of up to 4, spanning first-word-start to last-word-end', () => {
    const words = [
      { word: 'the', startSeconds: 0.0, endSeconds: 0.2 },
      { word: 'quick', startSeconds: 0.2, endSeconds: 0.5 },
      { word: 'brown', startSeconds: 0.5, endSeconds: 0.8 },
      { word: 'fox', startSeconds: 0.8, endSeconds: 1.0 },
      { word: 'jumps', startSeconds: 1.1, endSeconds: 1.4 },
    ]
    const phrases = groupWordsIntoPhrases(words, 4)
    expect(phrases).toEqual([
      { text: 'the quick brown fox', startSeconds: 0.0, endSeconds: 1.0 },
      { text: 'jumps', startSeconds: 1.1, endSeconds: 1.4 },
    ])
  })

  it('throws instead of infinite-looping when groupSize is not positive', () => {
    const words = [{ word: 'hi', startSeconds: 0, endSeconds: 0.2 }]
    expect(() => groupWordsIntoPhrases(words, 0)).toThrow()
    expect(() => groupWordsIntoPhrases(words, -1)).toThrow()
  })
})

describe('formatSrtTimestamp', () => {
  it('formats seconds as HH:MM:SS,mmm', () => {
    expect(formatSrtTimestamp(0)).toBe('00:00:00,000')
    expect(formatSrtTimestamp(65.5)).toBe('00:01:05,500')
    expect(formatSrtTimestamp(3661.25)).toBe('01:01:01,250')
  })

  it('clamps negative input to 00:00:00,000 instead of producing a malformed timestamp', () => {
    expect(formatSrtTimestamp(-1.5)).toBe('00:00:00,000')
  })
})

describe('buildSrt', () => {
  it('renders numbered cues with SRT timestamps, including phrases with apostrophes safely', () => {
    const srt = buildSrt([
      { text: "it's here", startSeconds: 0, endSeconds: 1.2 },
      { text: 'don\'t wait', startSeconds: 1.3, endSeconds: 2.5 },
    ])
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,200\nit\'s here')
    expect(srt).toContain("2\n00:00:01,300 --> 00:00:02,500\ndon't wait")
  })
})

describe('burnCaptions execute', () => {
  it('returns a distinct SUBTITLES_FILTER_UNAVAILABLE refusal when ffmpeg lacks the subtitles filter (args-present shape)', async () => {
    // Real stderr from this tool's exact invocation
    // (`subtitles=<path>:force_style=...`) against a real libass-less
    // ffmpeg (8.1.2, confirmed live on this machine — see
    // task-7-report.md fix round 1). NOT "Unknown filter 'subtitles'." —
    // that string only comes from `ffmpeg -h filter=subtitles`, which this
    // tool never calls.
    execFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error & { stderr?: string }) => void) => {
      const err = new Error('Command failed') as Error & { stderr?: string }
      err.stderr = [
        "[AVFilterGraph @ 0x600003a80480] No option name near '/tmp/captions.srt'",
        '[AVFilterGraph @ 0x600003a80480] Error parsing a filter description around: ',
        "[AVFilterGraph @ 0x600003a80480] Error parsing filterchain 'subtitles=/tmp/captions.srt:force_style=...' around: ",
        'Error opening output file /tmp/captioned.mp4.',
        'Error opening output files: Invalid argument',
      ].join('\n')
      cb(err)
    })

    const result = await burnCaptions.execute!({
      videoFileId: 'v1',
      words: [{ word: 'hi', startSeconds: 0, endSeconds: 0.3 }],
    } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: 'SUBTITLES_FILTER_UNAVAILABLE' })
  })

  it('also recognizes the bare-filter ffmpeg error shape ("No such filter: \'subtitles\'")', async () => {
    execFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error & { stderr?: string }) => void) => {
      const err = new Error('Command failed') as Error & { stderr?: string }
      err.stderr = "[AVFilterGraph @ 0x1] No such filter: 'subtitles'\nError opening output files: Filter not found\n"
      cb(err)
    })

    const result = await burnCaptions.execute!({
      videoFileId: 'v1',
      words: [{ word: 'hi', startSeconds: 0, endSeconds: 0.3 }],
    } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: 'SUBTITLES_FILTER_UNAVAILABLE' })
  })

  it('falls back to the generic CAPTION_FAILED refusal for any other ffmpeg failure', async () => {
    execFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error & { stderr?: string }) => void) => {
      const err = new Error('Command failed') as Error & { stderr?: string }
      err.stderr = 'Some other ffmpeg error\n'
      cb(err)
    })

    const result = await burnCaptions.execute!({
      videoFileId: 'v1',
      words: [{ word: 'hi', startSeconds: 0, endSeconds: 0.3 }],
    } as never, baseCtx())

    expect(result).toMatchObject({ refused: true, refusalReason: 'CAPTION_FAILED' })
  })
})
