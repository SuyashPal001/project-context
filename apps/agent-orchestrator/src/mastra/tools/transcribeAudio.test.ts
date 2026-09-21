import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { inputSchema } from './transcribeAudio.js'

describe('transcribeAudio inputSchema', () => {
  it('requires fileId', () => {
    const ok = inputSchema.safeParse({ fileId: 'f1' })
    expect(ok.success).toBe(true)
    const missing = inputSchema.safeParse({})
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

describe('transcribeAudio execute — ffmpeg audio-extraction step', () => {
  it('extracts audio with -vn and -c:a aac before sending it to the gateway', async () => {
    const { transcribeAudio } = await import('./transcribeAudio.js')
    const fs = await import('node:fs')

    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-audio'))
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'hello world', words: [{ word: 'hello', startSeconds: 0, endSeconds: 0.4 }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const requestContext = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't1', agentId: 'a1', conversationId: 'c1', idToken: 'tok' })) requestContext.set(k, v)

    const result = await transcribeAudio.execute!(
      { fileId: 'f1' } as never,
      { requestContext, agent: { toolCallId: 'call-1' } } as never,
    )

    expect(result).toMatchObject({ text: 'hello world' })

    const ffmpegCall = execFile.mock.calls.find(call => call[0] === 'ffmpeg')
    expect(ffmpegCall).toBeDefined()
    const args = ffmpegCall![1] as string[]
    expect(args).toContain('-vn')
    const caIdx = args.indexOf('-c:a')
    expect(caIdx).toBeGreaterThanOrEqual(0)
    expect(args[caIdx + 1]).toBe('aac')

    vi.unstubAllGlobals()
  })
})
