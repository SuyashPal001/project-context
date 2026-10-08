import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { inputSchema, endCardGraph, cardOverlayX } from './compositeEndCard.js'
import { marksGraph } from './packshotMarks.js'

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

const G_16_9 = "[1:v]split[bgsrc][fgsrc];[bgsrc]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=40:2,eq=brightness=-0.12[bg];[fgsrc]scale=1652:1080:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=rgba,fade=t=in:st=8.5:d=0.4:alpha=1[card];[0:v][card]overlay=0:0:enable='gte(t,8.5)'[outv]"
const G_HOLD = "[0:v]tpad=stop_mode=clone:stop_duration=1.5[base];[1:v]split[bgsrc][fgsrc];[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=40:2,eq=brightness=-0.12[bg];[fgsrc]scale=928:1920:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=rgba,fade=t=in:st=19.95:d=0.4:alpha=1[card];[base][card]overlay=0:0:enable='gte(t,19.95)'[outv]"
const G_FACE = "[1:v]scale=360:1536:force_original_aspect_ratio=decrease,format=rgba,fade=t=in:st=5:d=0.4:alpha=1[card];[0:v][card]overlay=W*0.04:(H-h)/2:enable='gte(t,5)'[outv]"

describe('legacy end cards are byte-identical (X10, Review Focus 1)', () => {
  beforeEach(() => { vi.clearAllMocks() })
  it('endCardGraph without marks is unchanged', () => {
    expect(endCardGraph(1920, 1080, 8.5)).toBe(G_16_9)
    expect(endCardGraph(1080, 1920, 19.95, 1.5)).toBe(G_HOLD)
    expect(endCardGraph(1080, 1920, 5, 0, { scale: '360:1536', x: 'W*0.04' })).toBe(G_FACE)
  })
  it('execute without the new inputs: ffprobe then one ffmpeg, today\'s exact arguments', async () => {
    const { compositeEndCard } = await import('./compositeEndCard.js')
    const { uploadGeneratedFile } = await import('../../persistence.js')
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    isUnlimited.mockResolvedValue(false)
    resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 1_000 } })
    shouldRequireApproval.mockResolvedValue(false)
    fetchPresignedUrl.mockImplementation(async (fileId: string) => `https://cdn.example/${fileId}`)
    downloadToSessionCache.mockImplementation(async (_s: string, fileId: string) => ({ filePath: `/tmp/${fileId}.mp4`, buf: Buffer.from('x'), mimeType: 'video/mp4' }))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'carded1', name: 'carded.mp4', type: 'video/mp4', size: 8 })
    execFile.mockImplementation((cmd: string, _a: string[], _o: unknown, cb: (err: Error | null, res: { stdout: string; stderr: string }) => void) => {
      if (cmd === 'ffprobe') return cb(null, { stdout: JSON.stringify({ streams: [{ width: 1920, height: 1080 }], format: { duration: '10.0' } }), stderr: '' })
      cb(null, { stdout: '', stderr: '' })
    })
    const rc = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })) rc.set(k, v)
    const result = await compositeEndCard.execute!({ videoFileId: 'v1', productPhotoFileId: 'p1', aspectRatio: '16:9' } as never, { requestContext: rc, agent: { toolCallId: 'call-1' } } as never)
    expect(result).toMatchObject({ fileId: 'carded1' })
    expect(execFile.mock.calls.map((c) => c[0])).toEqual(['ffprobe', 'ffmpeg'])
    expect(execFile.mock.calls[1][1]).toEqual([
      '-y', '-i', '/tmp/v1.mp4',
      '-loop', '1', '-framerate', '30', '-t', '10', '-i', '/tmp/p1.mp4',
      '-filter_complex', G_16_9,
      '-map', '[outv]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      expect.stringMatching(/carded\.mp4$/),
    ])
  })
})

describe('endCardGraph with marks (M3, M4)', () => {
  it('renames today\'s [outv] to [carded] and appends the marks', () => {
    const marks = { dissolveStart: 8.5, totalSeconds: 10, logoInput: '[2:v]', veg: { kind: 'veg' as const, rect: { x: 1812, y: 972, w: 54, h: 54 } } }
    expect(endCardGraph(1920, 1080, 8.5, 0, undefined, marks)).toBe(`${G_16_9.slice(0, -'[outv]'.length)}[carded];${marksGraph(marks)}`)
    expect(endCardGraph(1920, 1080, 8.5, 0, undefined, { dissolveStart: 8.5, totalSeconds: 10, logoInput: '[2:v]' })).toBe(G_16_9)
  })
  it('the schema: string enums and a plain bounded number (no numeric enum)', () => {
    const json = JSON.stringify(inputSchema, (_k, v) => (v && typeof v === 'object' && v.typeName === 'ZodLiteral' && typeof v.value === 'number' ? '__NUMERIC_LITERAL__' : v))
    expect(json).not.toContain('__NUMERIC_LITERAL__')
    const ok = { videoFileId: 'v1', productPhotoFileId: 'p1', aspectRatio: '16:9' }
    expect(inputSchema.safeParse({ ...ok, logoFileId: 'l1', vegMark: 'non_veg', disclaimerLines: 2 }).success).toBe(true)
    expect(inputSchema.safeParse({ ...ok, vegMark: 'vegan' }).success).toBe(false)
    expect(inputSchema.safeParse({ ...ok, disclaimerLines: 3 }).success).toBe(false)
  })
})

describe('logo and veg mark on the packshot (M3, M4)', () => {
  beforeEach(() => { vi.clearAllMocks() })
  const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  const OPAQUE_RGBA = Buffer.alloc(16, 255)
  const CLEAR_RGBA = Buffer.from([255, 0, 0, 255, 0, 0, 0, 0])
  function setup(opts: { logoBuf?: Buffer; logoUnreadable?: boolean; rgba?: Buffer; faces?: Array<{ x0: number; y0: number; x1: number; y1: number }> } = {}) {
    isUnlimited.mockResolvedValue(false)
    resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 1_000 } })
    shouldRequireApproval.mockResolvedValue(false)
    fetchPresignedUrl.mockImplementation(async (id: string) => `https://cdn.example/${id}`)
    downloadToSessionCache.mockImplementation(async (_s: string, id: string) => ({
      filePath: `/tmp/${id}`, buf: id === 'logo1' ? (opts.logoBuf ?? PNG_HEAD) : Buffer.from('x'), mimeType: 'application/octet-stream',
    }))
    execFile.mockImplementation((cmd: string, args: string[], _o: unknown, cb: (err: Error | null, res?: { stdout: string | Buffer; stderr: string }) => void) => {
      if (cmd === 'ffprobe' && args[args.length - 1] === '/tmp/logo1') {
        return opts.logoUnreadable ? cb(new Error('Invalid data found when processing input')) : cb(null, { stdout: JSON.stringify({ streams: [{ width: 800, height: 200 }] }), stderr: '' })
      }
      if (cmd === 'ffprobe') return cb(null, { stdout: JSON.stringify({ streams: [{ width: 1920, height: 1080 }], format: { duration: '10.0' } }), stderr: '' })
      if (args.includes('rawvideo')) return cb(null, { stdout: opts.rgba ?? OPAQUE_RGBA, stderr: '' })
      cb(null, { stdout: '', stderr: '' })
    })
    if (opts.faces) {
      sampleFrames.mockResolvedValue([{ data: 'xx', mime: 'image/jpeg' }])
      faceBoxes.mockResolvedValue(opts.faces)
      chooseCardColumn.mockReturnValue('left')
    }
  }
  async function run(extra: Record<string, unknown>) {
    const { compositeEndCard } = await import('./compositeEndCard.js')
    const { uploadGeneratedFile } = await import('../../persistence.js')
    const fs = await import('node:fs')
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-mp4'))
    ;(uploadGeneratedFile as ReturnType<typeof vi.fn>).mockResolvedValue({ fileId: 'carded1', name: 'carded.mp4', type: 'video/mp4', size: 8 })
    const rc = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })) rc.set(k, v)
    return compositeEndCard.execute!({ videoFileId: 'v1', productPhotoFileId: 'p1', aspectRatio: '16:9', ...extra } as never, { requestContext: rc, agent: { toolCallId: 'call-1' } } as never)
  }
  const composite = () => {
    const call = execFile.mock.calls.find((c) => c[0] === 'ffmpeg' && !(c[1] as string[]).includes('rawvideo'))!
    const args = call[1] as string[]
    return { args, graph: args[args.indexOf('-filter_complex') + 1] }
  }

  it('refuses LOGO_IS_PRODUCT_PHOTO before fetching anything (Review Focus 5)', async () => {
    setup()
    expect(await run({ logoFileId: 'p1' })).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^LOGO_IS_PRODUCT_PHOTO: /) })
    expect(fetchPresignedUrl).not.toHaveBeenCalled()
    expect(spendCredits).not.toHaveBeenCalled()
  })
  it.each([
    ['an SVG', Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'), 'LOGO_NOT_RASTER: upload the logo as PNG or JPG'],
    ['a GIF', Buffer.from('GIF89a......'), expect.stringMatching(/^LOGO_NOT_IMAGE: /)],
  ])('refuses %s logo before the charge or any ffmpeg (X3)', async (_n, logoBuf, reason) => {
    setup({ logoBuf })
    expect(await run({ logoFileId: 'logo1' })).toMatchObject({ refused: true, refusalReason: reason })
    expect(spendCredits).not.toHaveBeenCalled()
    expect(execFile).not.toHaveBeenCalled()
  })
  it('refuses LOGO_NOT_IMAGE when ffmpeg cannot read the logo, uncharged', async () => {
    setup({ logoUnreadable: true })
    expect(await run({ logoFileId: 'logo1' })).toMatchObject({ refused: true, refusalReason: expect.stringMatching(/^LOGO_NOT_IMAGE: /) })
    expect(spendCredits).not.toHaveBeenCalled()
  })
  it('a fully opaque logo gets the plate, top centre; the veg mark sits above a 2-line disclaimer; one composite pass', async () => {
    setup()
    expect(await run({ logoFileId: 'logo1', vegMark: 'veg', disclaimerLines: 2 })).toMatchObject({ fileId: 'carded1' })
    expect(spendCredits).toHaveBeenCalledTimes(1)
    expect(execFile.mock.calls.filter((c) => c[0] === 'ffmpeg' && !(c[1] as string[]).includes('rawvideo'))).toHaveLength(1)
    const { args, graph } = composite()
    expect(args.filter((a) => a === '-i')).toHaveLength(3)
    expect(args[args.indexOf('/tmp/logo1') - 1]).toBe('-i')
    expect(args.slice(args.indexOf('/tmp/logo1') - 7, args.indexOf('/tmp/logo1'))).toEqual(['-loop', '1', '-framerate', '30', '-t', '10', '-i'])
    expect(graph).toContain('[carded];[2:v]scale=324:81,format=rgba,pad=340:97:8:8:color=white,')
    expect(graph).toContain("[carded][logo]overlay=790:54:enable='gte(t,8.5)'[withlogo]")
    expect(graph).toContain("[withlogo][veg]overlay=1812:749:enable='gte(t,8.5)'[outv]")
  })
  it('a transparent logo is laid as it is, with a shadow (X2)', async () => {
    setup({ rgba: CLEAR_RGBA })
    await run({ logoFileId: 'logo1' })
    const { graph } = composite()
    expect(graph).toContain('[2:v]scale=388:97,format=rgba,split[lgf][lgs]')
    expect(graph).toContain("[shadowed][logo]overlay=766:54:enable='gte(t,8.5)'[outv]")
    expect(graph).not.toContain('color=white')
  })
  it('avoids a face in the top band: the logo moves to a clear top corner, the mark to the opposite bottom corner (Review Focus 4)', async () => {
    setup({ faces: [{ x0: 0.4, y0: 0.02, x1: 0.6, y1: 0.3 }] })
    await run({ logoFileId: 'logo1', vegMark: 'non_veg', avoidFaces: true })
    const { graph } = composite()
    expect(graph).toContain("[carded][logo]overlay=1526:54:enable='gte(t,8.5)'[withlogo]")
    expect(graph).toContain("[withlogo][veg]overlay=54:972:enable='gte(t,8.5)'[outv]")
  })
  it('the veg mark alone adds no input and no logo', async () => {
    setup()
    await run({ vegMark: 'veg' })
    const { args, graph } = composite()
    expect(args.filter((a) => a === '-i')).toHaveLength(2)
    expect(graph).toBe(`${G_16_9.slice(0, -'[outv]'.length)}[carded];${marksGraph({ dissolveStart: 8.5, totalSeconds: 10, logoInput: '[2:v]', veg: { kind: 'veg', rect: { x: 1812, y: 972, w: 54, h: 54 } } })}`)
  })
  it('disclaimerLines alone changes nothing', async () => {
    setup()
    await run({ disclaimerLines: 2 })
    expect(composite().graph).toBe(G_16_9)
  })
})
