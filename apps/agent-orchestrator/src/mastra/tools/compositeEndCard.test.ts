import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { inputSchema } from './compositeEndCard.js'

describe('compositeEndCard inputSchema', () => {
  it('requires videoFileId, productPhotoFileId, and aspectRatio', () => {
    const ok = inputSchema.safeParse({ videoFileId: 'v1', productPhotoFileId: 'p1', aspectRatio: '9:16' })
    expect(ok.success).toBe(true)
    const missing = inputSchema.safeParse({ videoFileId: 'v1', productPhotoFileId: 'p1' })
    expect(missing.success).toBe(false)
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
