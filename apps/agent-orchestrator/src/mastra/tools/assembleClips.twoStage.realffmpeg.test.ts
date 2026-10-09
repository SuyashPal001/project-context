// Real ffmpeg, not mocked. Tagged: runs only with RUN_REAL_FFMPEG=1.
// Part 2.3 (J3): a 30s ad's 20 clips are joined as two halves, then the two
// halves are joined, with the same assemble_clips. Needs no libass.
import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RequestContext } from '@mastra/core/request-context'

vi.mock('@serverless-saas/credits', () => ({ spendCredits: vi.fn(), resolveRate: vi.fn(async () => null), isUnlimited: vi.fn(async () => true), costMicro: () => 0n }))
vi.mock('../../usage.js', () => ({ getPool: vi.fn() }))
const dir = mkdtempSync(join(tmpdir(), 'asm-two-stage-'))
let outputs = 0
// Each upload is written back into the fake cache, so a join's output can be the next join's input.
vi.mock('../../persistence.js', () => ({
  uploadGeneratedFile: vi.fn(async (_t: string, i: { content: Buffer }) => {
    const fileId = `out${++outputs}`
    writeFileSync(join(dir, `${fileId}.mp4`), i.content)
    return { fileId, name: `${fileId}.mp4`, type: 'video/mp4', size: i.content.length }
  }),
}))
vi.mock('./mediaCache.js', () => ({
  fetchPresignedUrl: vi.fn(async (id: string) => id),
  downloadToSessionCache: vi.fn(async (_s: string, id: string) => ({ filePath: join(dir, `${id}.mp4`) })),
}))
vi.mock('./generationApproval.js', () => ({ shouldRequireApproval: vi.fn(async () => false) }))

import { assembleClips } from './assembleClips.js'

const probe = (file: string, entries: string, stream?: string) =>
  execFileSync('ffprobe', ['-v', 'error', ...(stream ? ['-select_streams', stream] : []), '-show_entries', entries, '-of', 'csv=p=0', file]).toString().trim()

/** Peak absolute sample (0..1) of the mono 48 kHz audio between two times. */
function peak(file: string, from: number, to: number): number {
  const pcm = execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(from), '-t', String(to - from), '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'])
  let max = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) max = Math.max(max, Math.abs(pcm.readInt16LE(i)))
  return max / 32768
}

describe.skipIf(!process.env.RUN_REAL_FFMPEG)('assemble_clips two-stage join against real ffmpeg (J3)', () => {
  it('joins 20 clips at 24fps as two halves, then the halves, keeping fps, length and the seam fade', async () => {
    const lens = Array.from({ length: 20 }, (_, i) => [1.5, 1.4, 1.6, 1.5][i % 4])
    lens.forEach((d, i) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=24:duration=${d}`, '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 20}:duration=${d}`, '-shortest', '-c:v', 'libx264', '-c:a', 'aac', join(dir, `c${i}.mp4`)]))
    const rc = new RequestContext()
    for (const [k, v] of Object.entries({ tenantId: 't', conversationId: 'c', idToken: 'tok' })) rc.set(k, v)
    const run = (clipFileIds: string[], roomTone: boolean, id: string) =>
      assembleClips.execute!({ clipFileIds, preserveAudio: true, roomTone, aspectRatio: '16:9' } as never, { requestContext: rc, agent: { toolCallId: id } } as never) as Promise<{ fileId?: string; fps?: number; refused?: boolean; refusalReason?: string }>

    const ids = lens.map((_, i) => `c${i}`)
    // Each half is joined as Director does it: preserveAudio and roomTone true.
    const half1 = await run(ids.slice(0, 10), true, 'h1')
    const half2 = await run(ids.slice(10), true, 'h2')
    expect(half1).toMatchObject({ fps: 24 })
    expect(half2).toMatchObject({ fps: 24 })
    // The final join: the two halves, no transitions, roomTone false (each half already carries it).
    const final = await run([half1.fileId!, half2.fileId!], false, 'final')
    expect(final.refused).toBeFalsy()
    expect(final).toMatchObject({ fps: 24 })

    const out = join(dir, `${final.fileId}.mp4`)
    expect(probe(out, 'stream=r_frame_rate', 'v:0')).toBe('24/1')
    const total = lens.reduce((a, b) => a + b, 0)
    const dur = parseFloat(probe(out, 'format=duration'))
    // assemble_clips's own tolerance, applied over all 20 pieces: 0.1s + 0.03s per piece.
    // Measured on the reference Mac: 30.21s for 30s of pieces.
    expect(Math.abs(dur - total)).toBeLessThanOrEqual(0.1 + 0.03 * lens.length)

    // The seam between the halves gets the 40ms fades: the quietest 10ms
    // window near it is far quieter than the tone just before it.
    const seam = parseFloat(probe(join(dir, `${half1.fileId}.mp4`), 'stream=duration', 'v:0'))
    const before = peak(out, seam - 0.5, seam - 0.3)
    let quietest = Infinity
    for (let t = seam - 0.15; t <= seam + 0.15; t += 0.005) quietest = Math.min(quietest, peak(out, t, t + 0.01))
    expect(before).toBeGreaterThan(0.05)
    expect(quietest).toBeLessThan(before * 0.25)
  }, 300_000)

  it('still refuses a 13-clip join (the 12-clip cap is unchanged)', async () => {
    const { inputSchema } = await import('./assembleClips.js')
    expect(inputSchema.safeParse({ clipFileIds: Array.from({ length: 13 }, (_, i) => `c${i}`), preserveAudio: true, aspectRatio: '16:9' }).success).toBe(false)
  })
})
