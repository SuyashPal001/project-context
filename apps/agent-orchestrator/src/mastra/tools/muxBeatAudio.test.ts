import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { inputSchema } from './muxBeatAudio.js'

describe('muxBeatAudio inputSchema', () => {
  it('requires videoFileId and audioFileId', () => {
    const ok = inputSchema.safeParse({ videoFileId: 'v1', audioFileId: 'a1' })
    expect(ok.success).toBe(true)
    const missing = inputSchema.safeParse({ videoFileId: 'v1' })
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

describe('muxBeatAudio execute — ffmpeg invocation', () => {
  it('never passes -shortest, and pads the audio stream with apad so the video-side tpad target is actually reached', async () => {
    const { muxBeatAudio } = await import('./muxBeatAudio.js')
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
      fileId: 'muxed1', name: 'muxed.mp4', type: 'video/mp4', size: 8,
    })

    execFile.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, res: { stdout: string; stderr: string }) => void) => {
      if (cmd === 'ffprobe') { cb(null, { stdout: '4.0\n', stderr: '' }); return }
      cb(null, { stdout: '', stderr: '' })
    })

    const requestContext = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })) requestContext.set(k, v)

    const result = await muxBeatAudio.execute!(
      { videoFileId: 'v1', audioFileId: 'a1' } as never,
      { requestContext, agent: { toolCallId: 'call-1' } } as never,
    )

    expect(result).toMatchObject({ fileId: 'muxed1' })

    const ffmpegCall = execFile.mock.calls.find(call => call[0] === 'ffmpeg')
    expect(ffmpegCall).toBeDefined()
    const args = ffmpegCall![1] as string[]
    expect(args).not.toContain('-shortest')
    const filterComplexIdx = args.indexOf('-filter_complex')
    expect(filterComplexIdx).toBeGreaterThanOrEqual(0)
    expect(args[filterComplexIdx + 1]).toContain('apad')
  })
})
