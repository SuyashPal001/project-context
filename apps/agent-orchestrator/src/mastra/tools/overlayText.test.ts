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
const { uploadGeneratedFile, uploadFileWithKey } = vi.hoisted(() => ({ uploadGeneratedFile: vi.fn(), uploadFileWithKey: vi.fn() }))
vi.mock('../../persistence.js', () => ({
  uploadGeneratedFile, uploadFileWithKey,
  generatedFileKey: (c: string, t: string, e: string) => `generated/${c}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-${t.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${e}`,
}))
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
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), writeFileSync: vi.fn(actual.writeFileSync) }
})
const { sampleFrames, faceBoxes, gatewayAsk } = vi.hoisted(() => ({
  sampleFrames: vi.fn(), faceBoxes: vi.fn(), gatewayAsk: vi.fn(),
}))
vi.mock('./tvcChecks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tvcChecks.js')>()
  return { ...actual, sampleFrames, faceBoxes, gatewayAsk }
})
import * as fs from 'node:fs'

import { inputSchema, escapeAssText, formatAssTimestamp, buildAss, overlayText, applyFacePlacement, legalStyles, resolveLegalBands } from './overlayText.js'

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

  it('moves text off a detected face when avoidFaces is set', async () => {
    execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (err: Error | null) => void) => cb(null))
    vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from('mp4'))
    uploadGeneratedFile.mockResolvedValueOnce({ fileId: 'out1', name: 'o.mp4', type: 'video/mp4', size: 3 })
    sampleFrames.mockResolvedValueOnce([{ data: 'xx', mime: 'image/jpeg' }])
    faceBoxes.mockResolvedValueOnce([{ x0: 0, y0: 0, x1: 1, y1: 0.25 }])
    gatewayAsk.mockReturnValueOnce(async () => ({}))

    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [okOverlay], avoidFaces: true } as never, baseCtx())

    // okOverlay's requested position is 'top'; a face spanning the whole
    // top band pushes it to the next free band, 'center'.
    expect(result).toMatchObject({ fileId: 'out1', positions: ['center'] })
  })

  it('keeps the requested placement and still succeeds when face detection throws (Review Focus 5)', async () => {
    execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (err: Error | null) => void) => cb(null))
    vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from('mp4'))
    uploadGeneratedFile.mockResolvedValueOnce({ fileId: 'out1', name: 'o.mp4', type: 'video/mp4', size: 3 })
    sampleFrames.mockImplementationOnce(() => { throw new Error('ffmpeg sampling failed') })

    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [okOverlay], avoidFaces: true } as never, baseCtx())

    expect(result).toMatchObject({ fileId: 'out1', positions: [okOverlay.position] })
  })
})

describe('avoidFaces placement (O1)', () => {
  it('moves an overlay off a face and shrinks when no band is free', () => {
    const out = applyFacePlacement(
      [{ text: 'bubbli', startSeconds: 12, endSeconds: 14.8, position: 'center', size: 'large' }, { text: 'hi', startSeconds: 0, endSeconds: 1, position: 'top' }],
      [[{ x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 }], [{ x0: 0, y0: 0, x1: 1, y1: 1 }]],
    )
    expect(out[0]).toMatchObject({ position: 'top', size: 'large' })
    expect(out[1]).toMatchObject({ position: 'top', size: 'small' })
  })
  it('keeps the requested placement when face detection gave nothing (Review Focus 5)', () => {
    const out = applyFacePlacement([{ text: 'x', startSeconds: 0, endSeconds: 1, position: 'bottom' }], [null])
    expect(out[0].position).toBe('bottom')
  })
})

import { createHash } from 'node:crypto'

const LEGACY = [
  { text: "Don't wait", startSeconds: 0, endSeconds: 2, position: 'top' as const },
  { text: 'Soft all day', startSeconds: 12, endSeconds: 15, position: 'center' as const, size: 'large' as const },
  { text: 'Creative visualisation', startSeconds: 4, endSeconds: 8, position: 'bottom' as const, size: 'small' as const },
]
const LEGACY_SHA = '57b41e1f0f04bf707c8173700d2569d76a2925221f3fdea2a7775de9611b2a5e'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('legacy calls are byte-identical (Review Focus 1)', () => {
  it('buildAss without a legal overlay is unchanged', () => {
    expect(sha(buildAss(LEGACY))).toBe(LEGACY_SHA)
  })
  it('execute without a legal overlay: one ffmpeg call, same args, same ASS, same upload', async () => {
    execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (err: Error | null) => void) => cb(null))
    vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from('mp4'))
    uploadGeneratedFile.mockResolvedValueOnce({ fileId: 'out1', name: 'o.mp4', type: 'video/mp4', size: 3 })
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: LEGACY } as never, baseCtx())
    expect(result).toMatchObject({ fileId: 'out1', positions: ['top', 'center', 'bottom'] })
    expect(execFile).toHaveBeenCalledTimes(1)
    const [cmd, args] = execFile.mock.calls[0] as [string, string[]]
    expect(cmd).toBe('ffmpeg')
    expect(args.slice(0, 3)).toEqual(['-y', '-i', '/tmp/v1.mp4'])
    expect(args[3]).toBe('-vf')
    expect(args[4]).toMatch(/^subtitles=.*overlay\.ass$/)
    expect(args.slice(5)).toEqual(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'copy', expect.stringMatching(/overlaid\.mp4$/)])
    const assWrite = vi.mocked(fs.writeFileSync).mock.calls.find((c) => String(c[0]).endsWith('overlay.ass'))!
    expect(sha(String(assWrite[1]))).toBe(LEGACY_SHA)
    expect(uploadGeneratedFile).toHaveBeenCalledWith('tok', expect.objectContaining({ conversationId: 'c1', title: 'Video with Text Overlay', extension: 'mp4' }))
    expect(uploadFileWithKey).not.toHaveBeenCalled()
  })
})

const LEGAL_X = 'our new cream evens rare scars so an owner can wear more mascara as summer comes even nervous users are serene'
const LEGAL_3 = 'Results based on a consumer study of 120 women aged 25 to 40 over four weeks of daily use. Individual results may vary. Offer valid till stocks last. Prices include all taxes.'
function probeAnd(width: number, height: number, ffmpeg: (cb: (err: (Error & { stderr?: string }) | null) => void) => void = (cb) => cb(null)) {
  execFile.mockImplementation((cmd: string, _a: string[], _o: unknown, cb: (err: Error | null, res?: { stdout: string; stderr: string }) => void) => {
    if (cmd === 'ffprobe') return cb(null, { stdout: JSON.stringify({ streams: [{ width, height }] }), stderr: '' })
    ffmpeg(cb)
  })
}

describe('the legal style (L1)', () => {
  it('accepts size "legal" in the schema, as a string enum', () => {
    expect(inputSchema.safeParse({ videoFileId: 'v1', overlays: [{ ...okOverlay, size: 'legal' }] }).success).toBe(true)
  })
  it('adds three legal styles sized from the frame, after the unchanged ones', () => {
    const ass = buildAss([{ text: LEGAL_X, startSeconds: 0, endSeconds: 8, position: 'bottom', size: 'legal' }], { width: 1920, height: 1080 })
    expect(ass).toContain('Style: bottom-legal,Noto Sans,134,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,3,12,0,2,60,60,160,1')
    expect(ass).toContain('Style: top-legal,Noto Sans,134,')
    expect(ass.split('\n').filter((l) => l.startsWith('Style: '))).toHaveLength(12)
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:08.00,bottom-legal,,0,0,0,,our new cream evens rare scars so an owner can wear more\\Nmascara as summer comes even nervous users are serene')
    expect(legalStyles({ width: 1080, height: 1920 })[0]).toContain(',Noto Sans,75,')
  })
  it('refuses to build a legal overlay without the real frame', () => {
    expect(() => buildAss([{ ...okOverlay, size: 'legal' }])).toThrow('LEGAL_NEEDS_FRAME')
  })
  it('escapes ASS syntax in a disclaimer (E9)', () => {
    const ass = buildAss([{ text: '{T&C apply}\\', startSeconds: 0, endSeconds: 4, position: 'bottom', size: 'legal' }], { width: 1080, height: 1920 })
    expect(ass).toMatch(/bottom-legal,,0,0,0,,T&C apply$/m)
  })
  it('refuses LEGAL_TOO_LONG before charging or rendering', async () => {
    probeAnd(1920, 1080)
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [{ ...okOverlay, endSeconds: 9, text: LEGAL_3, size: 'legal' }] } as never, baseCtx())
    expect(result).toMatchObject({ refused: true, refusalReason: 'LEGAL_TOO_LONG: the disclaimer "Results based on a consumer study…" needs 3 lines; ASCI allows 2. Shorten it' })
    expect(spendCredits).not.toHaveBeenCalled()
    expect(execFile.mock.calls.map((c) => c[0])).toEqual(['ffprobe'])
  })
  it('refuses SOURCE_UNAVAILABLE, uncharged, when the frame cannot be probed', async () => {
    execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (err: Error | null) => void) => cb(new Error('probe failed')))
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [{ ...okOverlay, size: 'legal' }] } as never, baseCtx())
    expect(result).toMatchObject({ refused: true, refusalReason: 'SOURCE_UNAVAILABLE' })
    expect(spendCredits).not.toHaveBeenCalled()
  })
  it('puts a disclaimer at the bottom, sizes it from the probed frame, and uploads under the legal-text key', async () => {
    probeAnd(1920, 1080)
    vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from('mp4'))
    uploadFileWithKey.mockResolvedValueOnce({ fileId: 'out2', name: 'Video with Text Overlay.mp4', type: 'video/mp4', size: 3 })
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [{ ...okOverlay, endSeconds: 8, text: LEGAL_X, size: 'legal' }] } as never, baseCtx())
    expect(result).toMatchObject({ fileId: 'out2', positions: ['bottom'], creditsUsedMicro: '1000' })
    const assWrite = vi.mocked(fs.writeFileSync).mock.calls.find((c) => String(c[0]).endsWith('overlay.ass'))!
    expect(String(assWrite[1])).toContain('Style: bottom-legal,Noto Sans,134,')
    expect(uploadFileWithKey).toHaveBeenCalledWith('tok', expect.objectContaining({
      key: expect.stringMatching(/^generated\/c1\/[0-9a-f-]{36}-legal-text-video-with-text-overlay\.mp4$/),
      name: 'Video with Text Overlay.mp4', contentType: 'video/mp4',
    }))
    expect(uploadGeneratedFile).not.toHaveBeenCalled()
  })
  it('still refunds when ffmpeg fails on a legal call (charge-first unchanged)', async () => {
    probeAnd(1080, 1920, (cb) => cb(Object.assign(new Error('boom'), { stderr: 'boom' })))
    const result = await overlayText.execute!({ videoFileId: 'v1', overlays: [{ ...okOverlay, size: 'legal' }] } as never, baseCtx())
    expect(result).toMatchObject({ refused: true, refusalReason: 'OVERLAY_FAILED' })
    expect(spendCredits).toHaveBeenCalledTimes(2)
    expect(spendCredits.mock.calls[1][0]).toMatchObject({ kind: 'refund' })
  })
})

describe('a disclaimer is never shrunk (E11, Review Focus 5)', () => {
  it('keeps size legal and its requested band when every band has a face', () => {
    const out = applyFacePlacement([{ text: 'T&C apply', startSeconds: 0, endSeconds: 4, position: 'bottom', size: 'legal' }], [[{ x0: 0, y0: 0, x1: 1, y1: 1 }]])
    expect(out[0]).toMatchObject({ position: 'bottom', size: 'legal' })
  })
  it('may move to a free band, still at full size', () => {
    const out = applyFacePlacement([{ text: 'T&C apply', startSeconds: 0, endSeconds: 4, position: 'bottom', size: 'legal' }], [[{ x0: 0.3, y0: 0.7, x1: 0.7, y1: 1 }]])
    expect(out[0].size).toBe('legal')
    expect(out[0].position).not.toBe('bottom')
  })
})

describe('other text leaves the disclaimer\'s band (E5, Review Focus 5)', () => {
  const legal = { text: 'T&C apply', startSeconds: 4, endSeconds: 8, position: 'bottom' as const, size: 'legal' as const }
  it('moves overlapping bottom text to center, and leaves text outside the window alone', () => {
    const out = resolveLegalBands([legal, { text: 'SPF 30', startSeconds: 5, endSeconds: 6, position: 'bottom' }, { text: 'Hi', startSeconds: 0, endSeconds: 2, position: 'bottom' }])
    expect(out.map((o) => o.position)).toEqual(['bottom', 'center', 'bottom'])
  })
  it('moves the tagline to the top when a face pushed the disclaimer to center', () => {
    const out = resolveLegalBands([{ ...legal, position: 'center' }, { text: 'Soft all day', startSeconds: 6, endSeconds: 9, position: 'center', size: 'large' }])
    expect(out[1]).toMatchObject({ position: 'top', size: 'large' })
  })
  it('returns the very same array when there is no disclaimer', () => {
    const input = [okOverlay]
    expect(resolveLegalBands(input)).toBe(input)
  })
})
