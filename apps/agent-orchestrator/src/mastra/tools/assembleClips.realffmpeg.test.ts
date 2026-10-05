// Real ffmpeg, not mocked. Tagged: runs only with RUN_REAL_FFMPEG=1.
import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RequestContext } from '@mastra/core/request-context'

vi.mock('@serverless-saas/credits', () => ({ spendCredits: vi.fn(), resolveRate: vi.fn(async () => null), isUnlimited: vi.fn(async () => true), costMicro: () => 0n }))
vi.mock('../../usage.js', () => ({ getPool: vi.fn() }))
const uploaded: Buffer[] = []
vi.mock('../../persistence.js', () => ({ uploadGeneratedFile: vi.fn(async (_t: string, i: { content: Buffer }) => { uploaded.push(i.content); return { fileId: 'out', name: 'o.mp4', type: 'video/mp4', size: i.content.length } }) }))
const dir = mkdtempSync(join(tmpdir(), 'asm-real-'))
vi.mock('./mediaCache.js', () => ({
  fetchPresignedUrl: vi.fn(async (id: string) => id),
  downloadToSessionCache: vi.fn(async (_s: string, id: string) => ({ filePath: join(dir, `${id}.mp4`) })),
}))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval: vi.fn(async () => false) }))

import { assembleClips } from './assembleClips.js'

describe.skipIf(!process.env.RUN_REAL_FFMPEG)('assemble_clips against real ffmpeg', () => {
  it('joins four 24fps clips at 24fps with the exact summed length', async () => {
    const lens = [1.5, 0.9, 2.2, 3.1]
    lens.forEach((d, i) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=1280x720:rate=24:duration=${d}`, '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 100}:duration=${d}`, '-shortest', '-c:v', 'libx264', '-c:a', 'aac', join(dir, `c${i}.mp4`)]))
    const rc = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't', conversationId: 'c', idToken: 'tok' })) rc.set(k, v)
    const result = await assembleClips.execute!({ clipFileIds: ['c0', 'c1', 'c2', 'c3'], preserveAudio: true, aspectRatio: '16:9' } as never, { requestContext: rc, agent: { toolCallId: 'x' } } as never)
    expect(result).toMatchObject({ fileId: 'out', fps: 24 })
    const out = join(dir, 'joined.mp4'); writeFileSync(out, uploaded[0])
    const rate = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', out]).toString().trim()
    const dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString())
    expect(rate).toBe('24/1')
    expect(Math.abs(dur - lens.reduce((a, b) => a + b, 0))).toBeLessThanOrEqual(0.1)
  }, 120_000)
})
