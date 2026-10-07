import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { inputSchema, endCardGraph, cardOverlayX } from './compositeEndCard.js'

describe('compositeEndCard inputSchema', () => {
  it('requires videoFileId, productPhotoFileId, and aspectRatio', () => {
    const ok = inputSchema.safeParse({ videoFileId: 'v1', productPhotoFileId: 'p1', aspectRatio: '9:16' })
    expect(ok.success).toBe(true)
    const missing = inputSchema.safeParse({ videoFileId: 'v1', productPhotoFileId: 'p1' })
    expect(missing.success).toBe(false)
  })
})

describe('endCardGraph hold', () => {
  it('holds the last frame and lays the card over the hold for an ad that ends on speech', () => {
    const g = endCardGraph(1080, 1920, 19.95, 1.5)
    expect(g.startsWith('[0:v]tpad=stop_mode=clone:stop_duration=1.5[base];')).toBe(true)
    expect(g).toContain("[base][card]overlay=0:0:enable='gte(t,19.95)'[outv]")
  })
  it('keeps the old graph with no hold', () => {
    expect(endCardGraph(1080, 1920, 5)).not.toContain('tpad')
    expect(endCardGraph(1080, 1920, 5)).toContain('[0:v][card]overlay')
  })
})

describe('end card column (O1)', () => {
  it('centre, or a side third clear of the face', () => {
    expect(cardOverlayX('center')).toBe('(W-w)/2')
    expect(cardOverlayX('left')).toBe('W*0.04')
    expect(cardOverlayX('right')).toBe('W-w-W*0.04')
  })
})

describe('endCardGraph avoidFaces override (O1)', () => {
  it('uses the card override scale and position when given, with no bg/blur layer (F2)', () => {
    const g = endCardGraph(1080, 1920, 5, 0, { scale: '360:1536', x: cardOverlayX('right') })
    expect(g).toContain('[1:v]scale=360:1536:force_original_aspect_ratio=decrease,format=rgba')
    expect(g).toContain("overlay=W-w-W*0.04:(H-h)/2:enable='gte(t,5)'[outv]")
    expect(g).not.toContain('[bg]')
    expect(g).not.toContain('boxblur')
    expect(g).not.toContain('split')
  })
  it('keeps the default centered 86%-width box (with the bg/blur layer) when no override is given', () => {
    const g = endCardGraph(1080, 1920, 5)
    expect(g).toContain('[fgsrc]scale=928:1920:force_original_aspect_ratio=decrease[fg]')
    expect(g).toContain('[bg][fg]overlay=(W-w)/2:(H-h)/2')
    expect(g).toContain('boxblur')
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
const { sampleFrames, faceBoxes, gatewayAsk, chooseCardColumn } = vi.hoisted(() => ({
  sampleFrames: vi.fn(), faceBoxes: vi.fn(), gatewayAsk: vi.fn(), chooseCardColumn: vi.fn(),
}))
vi.mock('./tvcChecks.js', () => ({ sampleFrames, faceBoxes, gatewayAsk, chooseCardColumn }))

describe('compositeEndCard execute — ffmpeg invocation', () => {
  it('places -loop/-framerate/-t before the photo\'s -i flag, not after', async () => {
    const { compositeEndCard } = await import('./compositeEndCard.js')
    const { uploadGeneratedFile } = await import('../../persistence.js')
    const fs = await import('node:fs')

    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    isUnlimited.mockResolvedValue(false)
    resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 1_000 } })
    shouldRequireApproval.mockResolvedValue(false)
    fetchPresignedUrl.mockImplementation(async (fileId: string) => `https://cdn.example/${fileId}`)
    downloadToSessionCache.mockImplementation(async (_scope: string, fileId: string) => ({
      filePath: `/tmp/${fileId}.mp4`, buf: Buffer.from('x'), mimeType: 'video/mp4',
    }))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({
      fileId: 'carded1', name: 'carded.mp4', type: 'video/mp4', size: 8,
    })

    execFile.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, res: { stdout: string; stderr: string }) => void) => {
      if (cmd === 'ffprobe') {
        cb(null, { stdout: JSON.stringify({ streams: [{ width: 1080, height: 1920 }], format: { duration: '10.0' } }), stderr: '' })
        return
      }
      cb(null, { stdout: '', stderr: '' })
    })

    const requestContext = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })) requestContext.set(k, v)

    const result = await compositeEndCard.execute!(
      { videoFileId: 'v1', productPhotoFileId: 'p1', aspectRatio: '9:16' } as never,
      { requestContext, agent: { toolCallId: 'call-1' } } as never,
    )

    expect(result).toMatchObject({ fileId: 'carded1' })

    const ffmpegCall = execFile.mock.calls.find(call => call[0] === 'ffmpeg')
    expect(ffmpegCall).toBeDefined()
    const args = ffmpegCall![1] as string[]
    // photoPath is `/tmp/p1.mp4` (from the downloadToSessionCache mock) —
    // find the -i flag immediately preceding it.
    const photoIndex = args.findIndex(a => a.includes('/p1'))
    const loopIndex = args.indexOf('-loop')
    const framerateIndex = args.indexOf('-framerate')
    const tIndex = args.indexOf('-t')
    expect(loopIndex).toBeGreaterThanOrEqual(0)
    expect(framerateIndex).toBeGreaterThanOrEqual(0)
    expect(tIndex).toBeGreaterThanOrEqual(0)
    expect(photoIndex).toBeGreaterThan(0)
    expect(loopIndex).toBeLessThan(photoIndex)
    expect(framerateIndex).toBeLessThan(photoIndex)
    expect(tIndex).toBeLessThan(photoIndex)
  })
})

describe('compositeEndCard avoidFaces (O1)', () => {
  async function run(avoidFaces: boolean) {
    const { compositeEndCard } = await import('./compositeEndCard.js')
    const { uploadGeneratedFile } = await import('../../persistence.js')
    const fs = await import('node:fs')

    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    isUnlimited.mockResolvedValue(false)
    resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 1_000 } })
    shouldRequireApproval.mockResolvedValue(false)
    fetchPresignedUrl.mockImplementation(async (fileId: string) => `https://cdn.example/${fileId}`)
    downloadToSessionCache.mockImplementation(async (_scope: string, fileId: string) => ({
      filePath: `/tmp/${fileId}.mp4`, buf: Buffer.from('x'), mimeType: 'video/mp4',
    }))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({
      fileId: 'carded1', name: 'carded.mp4', type: 'video/mp4', size: 8,
    })
    execFile.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, res: { stdout: string; stderr: string }) => void) => {
      if (cmd === 'ffprobe') {
        cb(null, { stdout: JSON.stringify({ streams: [{ width: 1080, height: 1920 }], format: { duration: '10.0' } }), stderr: '' })
        return
      }
      cb(null, { stdout: '', stderr: '' })
    })

    const requestContext = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })) requestContext.set(k, v)

    await compositeEndCard.execute!(
      { videoFileId: 'v1', productPhotoFileId: 'p1', aspectRatio: '9:16', avoidFaces } as never,
      { requestContext, agent: { toolCallId: 'call-1' } } as never,
    )
    const ffmpegCalls = execFile.mock.calls.filter(call => call[0] === 'ffmpeg')
    const args = ffmpegCalls[ffmpegCalls.length - 1][1] as string[]
    return args[args.indexOf('-filter_complex') + 1]
  }

  it('shrinks and moves the card into the clear third when a face is found', async () => {
    sampleFrames.mockResolvedValueOnce([{ data: 'xx', mime: 'image/jpeg' }])
    faceBoxes.mockResolvedValueOnce([{ x0: 0.4, y0: 0.1, x1: 0.6, y1: 0.4 }])
    gatewayAsk.mockReturnValueOnce(async () => ({}))
    chooseCardColumn.mockReturnValueOnce('left')

    const filterComplex = await run(true)
    expect(filterComplex).toContain('scale=360:1536:force_original_aspect_ratio=decrease')
    expect(filterComplex).toContain('overlay=W*0.04:(H-h)/2')
  })

  it('keeps the default centered card when face detection throws (Review Focus 5)', async () => {
    chooseCardColumn.mockClear()
    sampleFrames.mockImplementationOnce(() => { throw new Error('ffmpeg sampling failed') })

    const filterComplex = await run(true)
    expect(filterComplex).toContain('scale=928:1920:force_original_aspect_ratio=decrease[fg]')
    expect(filterComplex).toContain('overlay=(W-w)/2:(H-h)/2')
    expect(chooseCardColumn).not.toHaveBeenCalled()
  })
})

describe('the end card never covers a disclaimer (E4)', () => {
  beforeEach(() => { vi.clearAllMocks() })
  const run = async () => {
    const { compositeEndCard } = await import('./compositeEndCard.js')
    const rc = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })) rc.set(k, v)
    return compositeEndCard.execute!({ videoFileId: 'v1', productPhotoFileId: 'p1', aspectRatio: '16:9' } as never, { requestContext: rc, agent: { toolCallId: 'call-1' } } as never)
  }
  it('refuses END_CARD_OVER_DISCLAIMER before any charge, download or ffmpeg', async () => {
    isUnlimited.mockResolvedValue(false)
    resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 1_000 } })
    fetchPresignedUrl.mockImplementation(async (fileId: string) => (fileId === 'v1'
      ? 'https://cdn.example/generated/c1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-legal-text-video-with-text-overlay.mp4?X-Amz-Signature=x'
      : `https://cdn.example/${fileId}`))
    const result = await run()
    expect(result).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^END_CARD_OVER_DISCLAIMER: /) })
    expect(spendCredits).not.toHaveBeenCalled()
    expect(downloadToSessionCache).not.toHaveBeenCalled()
    expect(execFile).not.toHaveBeenCalled()
  })
  it('does not refuse a packshot clip with no disclaimer', async () => {
    isUnlimited.mockResolvedValue(true)
    fetchPresignedUrl.mockImplementation(async (fileId: string) => `https://cdn.example/generated/c1/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-${fileId}.mp4`)
    downloadToSessionCache.mockRejectedValue(new Error('stop here'))
    expect(await run()).toMatchObject({ refused: true, refusalReason: 'SOURCE_UNAVAILABLE' })
    expect(downloadToSessionCache).toHaveBeenCalled()
  })
})
