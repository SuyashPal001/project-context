import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { spendCredits, resolveRate, isUnlimited } = vi.hoisted(() => ({
  spendCredits: vi.fn(), resolveRate: vi.fn(), isUnlimited: vi.fn(),
}))
vi.mock('@serverless-saas/credits', () => ({
  spendCredits, resolveRate, isUnlimited,
  costMicro: (schema: { per_call_micro?: number }, usage: { count?: number }) =>
    BigInt(schema.per_call_micro ?? 0) * BigInt(usage.count ?? 0),
}))
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
    expect(result).toMatchObject({ fileId: 'assembled1' })
  })

  it('rejects more than 3 clip file ids at the schema level', () => {
    // Parsed off the exported raw Zod schema, not assembleClips.inputSchema —
    // createTool's wrapped type is StandardSchemaWithJSON, which has no
    // .safeParse (this exact omission broke type-check in an earlier task).
    const parsed = inputSchema.safeParse({ clipFileIds: ['a', 'b', 'c', 'd'], aspectRatio: '9:16' })
    expect(parsed.success).toBe(false)
  })

  it('refuses with SOURCE_UNAVAILABLE if a clip cannot be downloaded, before running ffmpeg', async () => {
    downloadToSessionCache.mockRejectedValueOnce(new Error('too large'))

    const result = await assembleClips.execute!({ clipFileIds: ['c1'], aspectRatio: '9:16' } as never, baseCtx())

    expect(execFile).not.toHaveBeenCalled()
    expect(result).toMatchObject({ refused: true, refusalReason: 'SOURCE_UNAVAILABLE' })
  })
})
