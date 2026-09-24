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
const { uploadGeneratedFile } = vi.hoisted(() => ({ uploadGeneratedFile: vi.fn() }))
vi.mock('../../persistence.js', () => ({ uploadGeneratedFile }))
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
import * as fs from 'node:fs'

import { inputSchema, escapeAssText, formatAssTimestamp, buildAss, overlayText } from './overlayText.js'

function ctx(values: Record<string, string>) {
  const requestContext = new RequestContext()
  for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
  return { requestContext, agent: { toolCallId: 'call-1' } } as never
}
const baseCtx = () => ctx({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })
const okOverlay = { text: 'Stop scrolling', startSeconds: 0, endSeconds: 2, position: 'top' as const }

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

describe('overlayText inputSchema', () => {
  it('requires videoFileId and at least one valid overlay', () => {
    expect(inputSchema.safeParse({ videoFileId: 'v1', overlays: [okOverlay] }).success).toBe(true)
    expect(inputSchema.safeParse({ videoFileId: 'v1', overlays: [] }).success).toBe(false)
  })

  it('rejects an overlay whose end is not after its start, or with a bad position', () => {
    expect(inputSchema.safeParse({ videoFileId: 'v1', overlays: [{ ...okOverlay, endSeconds: 0 }] }).success).toBe(false)
    expect(inputSchema.safeParse({ videoFileId: 'v1', overlays: [{ ...okOverlay, position: 'left' }] }).success).toBe(false)
  })
})

describe('escapeAssText', () => {
  it('strips override braces and backslashes so copy cannot inject ASS tags', () => {
    expect(escapeAssText('{\\an5\\fs200}Hi\\Nthere')).toBe('an5fs200HiNthere')
  })

  it('flattens newlines and keeps apostrophes, colons and commas intact', () => {
    expect(escapeAssText("don't: wait,\nnow")).toBe("don't: wait, now")
  })
})

describe('formatAssTimestamp', () => {
  it('formats seconds as H:MM:SS.cc and clamps negatives', () => {
    expect(formatAssTimestamp(0)).toBe('0:00:00.00')
    expect(formatAssTimestamp(65.5)).toBe('0:01:05.50')
    expect(formatAssTimestamp(3661.25)).toBe('1:01:01.25')
    expect(formatAssTimestamp(-2)).toBe('0:00:00.00')
  })
})

describe('buildAss', () => {
  it('maps position and size to the right style and emits a timed Dialogue line', () => {
    const ass = buildAss([{ text: "it's here", startSeconds: 1, endSeconds: 3.5, position: 'bottom', size: 'large' }])
    expect(ass).toContain('Dialogue: 0,0:00:01.00,0:00:03.50,bottom-large,,0,0,0,,it\'s here')
    expect(ass).toMatch(/Style: top-medium,.*,8,60,60,160,1/)
    expect(ass).toMatch(/Style: center-small,.*,5,60,60,0,1/)
  })

  it('defaults size to medium', () => {
    expect(buildAss([okOverlay])).toContain(',top-medium,,')
  })
})

describe('overlayText execute', () => {
  it('refuses with SOURCE_UNAVAILABLE when there is no idToken', async () => {
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [okOverlay] } as never, ctx({ tenantId: 't1', conversationId: 'c1' }))
    expect(result).toMatchObject({ refused: true, refusalReason: 'SOURCE_UNAVAILABLE' })
  })

  it('refuses with INVALID_OVERLAY, before charging, when copy is empty after sanitizing', async () => {
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [{ ...okOverlay, text: '{}' }] } as never, baseCtx())
    expect(result).toMatchObject({ refused: true, refusalReason: 'INVALID_OVERLAY' })
    expect(spendCredits).not.toHaveBeenCalled()
  })

  it('returns insufficientCredits when the debit is rejected', async () => {
    spendCredits.mockRejectedValueOnce(Object.assign(new Error('no'), { name: 'InsufficientCreditsError' }))
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [okOverlay] } as never, baseCtx())
    expect(result).toMatchObject({ insufficientCredits: true })
    expect(execFile).not.toHaveBeenCalled()
  })

  it('returns SUBTITLES_FILTER_UNAVAILABLE when ffmpeg lacks libass, and refunds', async () => {
    execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (err: Error & { stderr?: string }) => void) => {
      const err = new Error('Command failed') as Error & { stderr?: string }
      err.stderr = "Error parsing filterchain 'subtitles=/tmp/x/overlay.ass' around: "
      cb(err)
    })
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [okOverlay] } as never, baseCtx())
    expect(result).toMatchObject({ refused: true, refusalReason: 'SUBTITLES_FILTER_UNAVAILABLE' })
    expect(spendCredits).toHaveBeenCalledTimes(2)
    expect(spendCredits.mock.calls[1][0]).toMatchObject({ kind: 'refund' })
  })

  it('returns generic OVERLAY_FAILED for other ffmpeg failures', async () => {
    execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (err: Error & { stderr?: string }) => void) => {
      const err = new Error('Command failed') as Error & { stderr?: string }
      err.stderr = 'boom'
      cb(err)
    })
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [okOverlay] } as never, baseCtx())
    expect(result).toMatchObject({ refused: true, refusalReason: 'OVERLAY_FAILED' })
  })

  it('uploads and returns the new video with credits used on success', async () => {
    execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (err: Error | null) => void) => cb(null))
    vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from('mp4'))
    uploadGeneratedFile.mockResolvedValueOnce({ fileId: 'out1', name: 'o.mp4', type: 'video/mp4', size: 3 })

    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [okOverlay] } as never, baseCtx())

    expect(result).toMatchObject({ fileId: 'out1', fileType: 'video/mp4', creditsUsedMicro: '1000' })
    const args = execFile.mock.calls[0][1] as string[]
    expect(args[args.indexOf('-vf') + 1]).toMatch(/^subtitles=.*overlay\.ass$/)
  })
})
