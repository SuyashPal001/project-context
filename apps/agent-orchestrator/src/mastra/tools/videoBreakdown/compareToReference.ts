import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { breakDownVideo, type Breakdown } from './breakDownVideo.js'
import { fetchVideo } from './fetchVideo.js'
import { aiService } from './aiServiceClient.js'
import { sampleFrames } from '../tvcChecks.js'
import { runGate, type CheckResult } from '../../scorers/video/gate.js'
import { poseLegsScorer, expressionScorer, samePersonScorer } from '../../scorers/video/visionScorers.js'

const r2 = (n: number) => Math.round(n * 100) / 100

const lookBounds = (reference: Breakdown) =>
  [0, ...reference.hidden_cuts.map((h) => h.at_s), ...(reference.cuts?.cuts ?? []), reference.video.durationS].sort((a, b) => a - b)

// Sample only at MEASURED times (spec §8: the first verifier sampled at Gemini's
// rough times and flagged correct timing as wrong).
export function pairTimes(reference: Breakdown): number[] {
  const bounds = lookBounds(reference)
  const mids = bounds.slice(0, -1).map((b, i) => r2((b + bounds[i + 1]) / 2))
  const moments = reference.overview.moments.filter((m) => m.measured).map((m) => m.t_s)
  return [...new Set([...moments, ...mids])].sort((a, b) => a - b)
}

type Ctx = { idToken: string; scopeId: string; conversationId: string }

export async function compareToReference(refInput: { url?: string; fileId?: string }, remakeFileId: string, ctx: Ctx, tenantId?: string) {
  const reference = await breakDownVideo(refInput, ctx, tenantId)
  const refVideo = await fetchVideo(refInput, ctx)
  const remake = await fetchVideo({ fileId: remakeFileId }, ctx)
  const times = pairTimes(reference).filter((t) => t < remake.durationS)
  const bounds = lookBounds(reference)
  const lookAt = (t: number) => Math.max(0, bounds.findIndex((b, i) => t >= b && t < (bounds[i + 1] ?? Infinity)))
  const dir = mkdtempSync(join(tmpdir(), 'compare-'))
  try {
    const refFrames = await sampleFrames(refVideo.filePath, times, dir)
    const newFrames = await sampleFrames(remake.filePath, times, dir)
    const checks: CheckResult[] = []
    for (const [i, t] of times.entries()) {
      const look = reference.overview.looks[lookAt(t)] ?? {}
      const feet = (look.leg_side === 'image-left' || look.leg_side === 'image-right') ? look.leg_side : 'center'
      checks.push(await runGate(poseLegsScorer, `pose-legs@${t}`, { tenantId, reference: refFrames[i], frame: newFrames[i], expectedFeet: feet }, [t]))
      checks.push(await runGate(expressionScorer, `expression@${t}`, { tenantId, reference: refFrames[i], frame: newFrames[i], expected: look.expression ?? 'same as reference' }, [t]))
    }
    checks.push(await runGate(samePersonScorer, 'same-person', { tenantId, reference: newFrames[0], frames: newFrames.slice(1) }, times))
    let brightnessJumps: { reference: number; remake: number } | null = null
    try {
      const [rj, mj] = await Promise.all([
        aiService<{ count: number }>('/media/brightness-jumps', { path: refVideo.filePath }),
        aiService<{ count: number }>('/media/brightness-jumps', { path: remake.filePath }),
      ])
      brightnessJumps = { reference: rj.count, remake: mj.count }
      checks.push({ name: 'brightness-jumps', status: mj.count > rj.count ? 'fail' : 'pass', reason: `reference ${rj.count}, remake ${mj.count}`, evidenceTimes: [] })
    } catch (e) {
      checks.push({ name: 'brightness-jumps', status: 'unknown', reason: (e as Error).message, evidenceTimes: [] })
    }
    const bad = checks.filter((c) => c.status !== 'pass')
    return { checks, brightnessJumps, summary: bad.length ? `${bad.length} difference(s): ${bad.map((c) => `${c.name} ${c.status} (${c.reason})`).join('; ')}` : 'matches the reference on every check' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const compareToReferenceTool = createTool({
  id: 'compare_to_reference',
  description: 'Compare a finished remake to its reference video at measured moments: pose and leg side, expression, same person throughout, and sudden brightness jumps. Use when the user asks how close the remake is.',
  inputSchema: z.object({ referenceUrl: z.string().url().optional(), referenceFileId: z.string().optional(), remakeFileId: z.string() }),
  outputSchema: z.object({ success: z.boolean(), result: z.any().optional(), error: z.string().optional() }),
  execute: async (input, execContext) => {
    const rc = execContext?.requestContext
    const idToken = rc?.get('idToken') as string | undefined
    const tenantId = rc?.get('tenantId') as string | undefined
    const sessionId = rc?.get('sessionId') as string | undefined
    const conversationId = (rc?.get('conversationId') as string | undefined) ?? sessionId
    if (!idToken || !sessionId || !conversationId) return { success: false, error: 'no_active_session' }
    if (!input.referenceUrl && !input.referenceFileId) return { success: false, error: 'give the reference as a link or an attached file' }
    try {
      return { success: true, result: await compareToReference({ url: input.referenceUrl, fileId: input.referenceFileId }, input.remakeFileId, { idToken, scopeId: tenantId ?? sessionId, conversationId }, tenantId) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
})
