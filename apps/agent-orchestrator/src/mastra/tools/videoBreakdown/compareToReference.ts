import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { linkSchema } from './links.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { breakDownVideo, recentBreakdown, type Breakdown } from './breakDownVideo.js'
import { fetchVideo } from './fetchVideo.js'
import { aiService } from './aiServiceClient.js'
import { sampleFrames, sideBySide, type Img } from '../tvcChecks.js'
import { generatedFileKey, uploadFileWithKey } from '../../../persistence.js'
import { runGate, type CheckResult } from '../../scorers/video/gate.js'
import { poseLegsScorer, expressionScorer, samePersonScorer } from '../../scorers/video/visionScorers.js'

const r2 = (n: number) => Math.round(n * 100) / 100

const lookBounds = (reference: Breakdown) =>
  [0, ...reference.hidden_cuts.map((h) => h.at_s), ...(reference.cuts?.cuts ?? []), reference.video.durationS].sort((a, b) => a - b)

const MAX_TIMES = 8

// Sample only at MEASURED times (spec §8: the first verifier sampled at Gemini's
// rough times and flagged correct timing as wrong). Capped: measured moments
// first, then evenly spaced look middles (review I4: a 32-cut ad meant ~70 calls).
export function pairTimes(reference: Breakdown): number[] {
  const bounds = lookBounds(reference)
  const moments = [...new Set(reference.overview.moments.filter((m) => m.measured).map((m) => m.t_s))].slice(0, MAX_TIMES)
  const mids = bounds.slice(0, -1).map((b, i) => r2((b + bounds[i + 1]) / 2)).filter((m) => !moments.includes(m))
  const room = MAX_TIMES - moments.length
  const picked = mids.length <= room ? mids : Array.from({ length: room }, (_, i) => mids[Math.floor((i * mids.length) / room)])
  return [...moments, ...picked].sort((a, b) => a - b)
}

type Look = Breakdown['overview']['looks'][number]

// Which look a time belongs to: by the hidden cuts' labels when there are any,
// else by the looks' own rough bounds, else by segment position (review I4).
export function lookFor(reference: Breakdown, t: number): Look | undefined {
  const looks = reference.overview.looks
  const hc = [...reference.hidden_cuts].sort((a, b) => a.at_s - b.at_s)
  if (hc.length && hc.every((h) => h.from && h.to)) {
    const before = hc.filter((h) => h.at_s <= t).pop()
    const label = before ? before.to : hc[0].from
    const hit = looks.find((l) => l.label === label)
    if (hit) return hit
  }
  if (looks.length && looks.every((l) => Number.isFinite(l.approx_start_s) && Number.isFinite(l.approx_end_s))) {
    return looks.find((l) => t >= l.approx_start_s && t < l.approx_end_s)
      ?? looks.reduce((a, b) => (Math.abs((a.approx_start_s + a.approx_end_s) / 2 - t) <= Math.abs((b.approx_start_s + b.approx_end_s) / 2 - t) ? a : b))
  }
  const bounds = lookBounds(reference)
  return looks[Math.max(0, bounds.findIndex((b, i) => t >= b && t < (bounds[i + 1] ?? Infinity)))]
}

type Ctx = { idToken: string; scopeId: string; conversationId: string }

type Box = [number, number, number, number]
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

// Face close-up from the measured subject box: its top third, a little padded (spec §8: expression on face crops).
export function faceBox(subject: Box | null): Box | null {
  if (!subject) return null
  const [x0, y0, x1, y1] = subject
  const h = y1 - y0
  return [clamp01(x0 - 0.05), clamp01(y0 - 0.02), clamp01(x1 + 0.05), clamp01(y0 + h * 0.35)]
}

const angleKey = (reference: Breakdown, t: number) => {
  const shot = (reference.shots ?? []).find((s) => t >= s.start_s && t < s.end_s)
  return shot && (shot.size || shot.angle) ? `${shot.size ?? ''}|${shot.angle ?? ''}` : ''
}

// Same person throughout, each frame judged against the earliest frame from the SAME
// camera angle, else the first frame (plan Global Constraints; review M6).
async function samePersonByAngle(reference: Breakdown, times: number[], frames: Img[], tenantId?: string): Promise<CheckResult> {
  const groups = new Map<number, number[]>()
  times.forEach((t, i) => {
    if (i === 0) return
    const key = angleKey(reference, t)
    const p = key ? times.findIndex((u, j) => j < i && angleKey(reference, u) === key) : -1
    const partner = p >= 0 ? p : 0
    groups.set(partner, [...(groups.get(partner) ?? []), i])
  })
  if (!groups.size) return runGate(samePersonScorer, 'same-person', { tenantId, reference: frames[0], frames: [] }, times)
  const results = await Promise.all([...groups].sort((a, b) => a[0] - b[0]).map(([p, idx]) =>
    runGate(samePersonScorer, `same-person@${times[p]}`, { tenantId, reference: frames[p], frames: idx.map((i) => frames[i]) }, [times[p], ...idx.map((i) => times[i])])))
  const status = results.some((r) => r.status === 'fail') ? 'fail' : results.some((r) => r.status === 'unknown') ? 'unknown' : 'pass'
  const failing = results.filter((r) => r.status !== 'pass')
  return { name: 'same-person', status, reason: failing.map((r) => `${r.name}: ${r.reason}`).join('; ') || 'same person in every frame', evidenceTimes: (failing.length ? failing : results).flatMap((r) => r.evidenceTimes) }
}

// Every difference comes with a picture a person can open (spec §8; review M8):
// reference | remake at that moment, or the remake frames for same-person.
async function attachEvidence(checks: CheckResult[], times: number[], refFrames: Img[], newFrames: Img[], dir: string, ctx: Ctx) {
  const at = (t: number) => times.indexOf(t)
  await Promise.all(checks.filter((c) => c.status !== 'pass' && c.evidenceTimes.length).map(async (c) => {
    const idx = c.evidenceTimes.map(at).filter((i) => i >= 0)
    if (!idx.length) return
    const imgs = c.name === 'same-person' ? idx.slice(0, 4).map((i) => newFrames[i]) : [refFrames[idx[0]], newFrames[idx[0]]]
    try {
      const jpg = await sideBySide(imgs, dir)
      const title = `compare ${c.name}`
      const att = await uploadFileWithKey(ctx.idToken, { key: generatedFileKey(ctx.conversationId, title, 'jpg'), name: `${title}.jpg`, content: jpg, contentType: 'image/jpeg' })
      if (att) c.evidenceFileIds = [att.fileId]
    } catch { /* evidence is best effort; the check result stands */ }
  }))
}


export async function compareToReference(refInput: { url?: string; fileId?: string }, remakeFileId: string, ctx: Ctx, tenantId?: string) {
  const reference = recentBreakdown(refInput, ctx) ?? await breakDownVideo(refInput, ctx, tenantId)
  const refVideo = await fetchVideo(refInput, ctx)
  const remake = await fetchVideo({ fileId: remakeFileId }, ctx)
  const times = pairTimes(reference).filter((t) => t < remake.durationS)
  const dir = mkdtempSync(join(tmpdir(), 'compare-'))
  try {
    const refFrames = await sampleFrames(refVideo.filePath, times, dir)
    const newFrames = await sampleFrames(remake.filePath, times, dir)
    const face = faceBox(reference.overview.subject_box ?? null)
    const refFaces = face ? await sampleFrames(refVideo.filePath, times, dir, face) : null
    const newFaces = face ? await sampleFrames(remake.filePath, times, dir, face) : null
    const perTime = await Promise.all(times.map(async (t, i) => {
      const look = lookFor(reference, t) ?? ({} as Partial<Look>)
      const out: CheckResult[] = []
      // Leg side is only judged where the breakdown actually read one.
      if (look.leg_side === 'image-left' || look.leg_side === 'image-right') {
        out.push(await runGate(poseLegsScorer, `pose-legs@${t}`, { tenantId, reference: refFrames[i], frame: newFrames[i], expectedFeet: look.leg_side }, [t]))
      }
      out.push(await runGate(expressionScorer, `expression@${t}`, { tenantId, reference: refFrames[i], frame: newFrames[i], referenceFace: refFaces?.[i], frameFace: newFaces?.[i], expected: look.expression ?? 'same as reference' }, [t]))
      return out
    }))
    const checks: CheckResult[] = perTime.flat()
    checks.push(await samePersonByAngle(reference, times, newFrames, tenantId))
    let brightnessJumps: { reference: number; remake: number } | null = null
    try {
      const [rj, mj] = await Promise.all([
        aiService<{ count: number }>('/media/brightness-jumps', { path: refVideo.filePath }),
        aiService<{ count: number }>('/media/brightness-jumps', { path: remake.filePath }),
      ])
      brightnessJumps = { reference: rj.count, remake: mj.count }
      checks.push({ name: 'brightness-jumps', status: mj.count !== rj.count ? 'fail' : 'pass', reason: `reference ${rj.count}, remake ${mj.count}`, evidenceTimes: [] })
    } catch (e) {
      checks.push({ name: 'brightness-jumps', status: 'unknown', reason: (e as Error).message, evidenceTimes: [] })
    }
    await attachEvidence(checks, times, refFrames, newFrames, dir, ctx)
    const bad = checks.filter((c) => c.status !== 'pass')
    return { checks, brightnessJumps, summary: bad.length ? `${bad.length} difference(s): ${bad.map((c) => `${c.name} ${c.status} (${c.reason})`).join('; ')}` : 'matches the reference on every check' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const compareToReferenceTool = createTool({
  id: 'compare_to_reference',
  description: 'Compare a finished remake to its reference video at measured moments: pose and leg side, expression, same person throughout, and sudden brightness jumps. Use when the user asks how close the remake is.',
  inputSchema: z.object({ referenceUrl: linkSchema.optional(), referenceFileId: z.string().optional(), remakeFileId: z.string() }),
  outputSchema: z.object({ success: z.boolean(), result: z.any().optional(), error: z.string().optional() }),
  execute: async (input, execContext) => {
    const rc = execContext?.requestContext
    const idToken = rc?.get('idToken') as string | undefined
    const tenantId = rc?.get('tenantId') as string | undefined
    const sessionId = rc?.get('sessionId') as string | undefined
    const conversationId = (rc?.get('conversationId') as string | undefined) ?? sessionId
    if (!idToken || !sessionId || !conversationId) return { success: false, error: 'no_active_session' }
    // Every check here is a paid model call; spend that cannot be billed is not made (review M4).
    if (!tenantId) return { success: false, error: 'no_tenant' }
    if (!input.referenceUrl && !input.referenceFileId) return { success: false, error: 'give the reference as a link or an attached file' }
    try {
      return { success: true, result: await compareToReference({ url: input.referenceUrl, fileId: input.referenceFileId }, input.remakeFileId, { idToken, scopeId: tenantId, conversationId }, tenantId) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
})
