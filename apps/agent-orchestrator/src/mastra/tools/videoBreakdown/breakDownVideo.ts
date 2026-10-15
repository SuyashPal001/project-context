import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { linkSchema, normalizeLink } from './links.js'
import { fetchVideo, probe, DownloadBlocked, type FetchedVideo } from './fetchVideo.js'
import { watchVideo, type WatchOverview } from './watchVideo.js'
import { aiService, type CutsResult, type HiddenCutsResult, type SoundResult, type PoseResult } from './aiServiceClient.js'
import { describeShots, type Shot } from './describeShots.js'
import { checkShortShots } from './checkShortShots.js'
import { refineMoments } from './refineMoments.js'

export interface Breakdown {
  video: Omit<FetchedVideo, 'filePath'>; overview: WatchOverview; measured: boolean
  cuts: CutsResult | null; hidden_cuts: HiddenCutsResult['hidden_cuts']; sound: Omit<SoundResult, 'curve_db'> | null
  pose: PoseResult | null
  // true when only Gemini watched a link we could not download: nothing is measured
  watch_only?: boolean
  shots: Shot[]; sound_arc: string; short_shot_check: { checked: number; status: 'ok' | 'unknown' }; warnings: string[]
}

// Real errors go to the server log; the breakdown's warnings stay in plain words because
// the agent may repeat them to the user (no provider or service names).
function logStep(step: string, e: unknown) {
  console.error(`[breakDownVideo] ${step} failed: ${e instanceof Error ? e.message : String(e)}`)
}

export function mergeBounds(durationS: number, cuts: number[], hidden: number[], fadeStarts: number[]): number[] {
  const h = hidden.filter((x) => cuts.every((c) => Math.abs(x - c) > 0.5))
  const all = [...new Set([...cuts, ...h, ...fadeStarts])].filter((x) => x > 0 && x < durationS).sort((a, b) => a - b)
  const out = [0]
  for (const x of all) if (x - out[out.length - 1] >= 0.15) out.push(x)
  out.push(Math.round(durationS * 100) / 100)
  return out
}

export function fillMissingShots(bounds: number[], shots: Shot[]): Shot[] {
  const byN = new Map(shots.map((s) => [s.n, s]))
  // Measured boundaries always win over the model's own shot times (review I1).
  return bounds.slice(0, -1).map((b, i) => ({ ...(byN.get(i + 1) ?? { subject: 'unclear', action: 'unclear' }), n: i + 1, start_s: b, end_s: bounds[i + 1] }))
}

// Each look's span: from the hidden cuts and their labels when there are any,
// else the looks' own rough bounds (empty ones dropped).
export function lookSpans(overview: Pick<WatchOverview, 'looks'>, hidden: HiddenCutsResult['hidden_cuts'], durationS: number): Array<{ label: string; start_s: number; end_s: number }> {
  const hc = [...hidden].sort((a, b) => a.at_s - b.at_s)
  if (hc.length && hc.every((h) => h.from && h.to)) {
    const bounds = [0, ...hc.map((h) => h.at_s), durationS]
    return bounds.slice(0, -1).map((b, i) => ({ label: i === 0 ? hc[0].from : hc[i - 1].to, start_s: b, end_s: bounds[i + 1] }))
  }
  return overview.looks
    .map((l) => ({ label: l.label, start_s: Math.max(0, l.approx_start_s), end_s: Math.min(durationS, l.approx_end_s) }))
    .filter((l) => Number.isFinite(l.start_s) && Number.isFinite(l.end_s) && l.end_s > l.start_s)
}

// The latest breakdown per tenant scope and link, so a later comparison checks the
// remake against the SAME breakdown it was planned from, without paying again (review I3).
const RECENT_MAX = 50
const recent = new Map<string, Breakdown>()
const recentKey = (input: { url?: string; fileId?: string }, scopeId: string) => `${scopeId}|${input.url ? normalizeLink(input.url) : ''}|${input.fileId ?? ''}`
export function recentBreakdown(input: { url?: string; fileId?: string }, ctx: { scopeId: string }): Breakdown | undefined {
  return recent.get(recentKey(input, ctx.scopeId))
}

export async function breakDownVideo(input: { url?: string; fileId?: string }, ctx: { idToken: string; scopeId: string; conversationId: string }, tenantId?: string): Promise<Breakdown> {
  let video: FetchedVideo
  try {
    video = await fetchVideo(input, ctx)
  } catch (e) {
    if (e instanceof DownloadBlocked) return watchOnlyBreakdown(e, tenantId)
    throw e
  }
  if (video.tooLong) throw new Error(`The video is ${Math.round(video.durationS)}s long. Ask the user which part (up to 90s) to clone.`)
  const b = await breakDownFetched(video, tenantId)
  const key = recentKey(input, ctx.scopeId)
  recent.delete(key)
  recent.set(key, b)
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value!)
  return b
}

// YouTube blocked our download: Gemini still watches the link, but nothing can be
// measured, so every time and leg side is marked as Gemini's reading and the user is
// asked for the file before any paid remake (spec §8a). Not cached for compare.
async function watchOnlyBreakdown(e: DownloadBlocked, tenantId?: string): Promise<Breakdown> {
  const durationS = e.durationS ?? NaN  // unknown: the watch runs at its cheapest rate
  const o = await watchVideo({ filePath: '', youtubeUrl: e.youtubeUrl, durationS }, tenantId)
  const overview: WatchOverview = {
    ...o,
    moments: o.moments.map((m) => ({ ...m, measured: false })),
    looks: o.looks.map((l) => ({ ...l, leg_side_source: 'gemini' as const, moves: (l.moves ?? []).map((v) => ({ ...v, measured: false })) })),
  }
  return {
    video: { fileId: '', durationS: e.durationS ?? 0, width: 0, height: 0, fps: 0, hasAudio: false, caption: e.caption, song: e.song, youtubeUrl: e.youtubeUrl, platform: 'youtube', tooLong: false },
    overview, measured: false, watch_only: true, cuts: null, hidden_cuts: [], sound: null, pose: null, shots: [], sound_arc: o.sound,
    short_shot_check: { checked: 0, status: 'unknown' },
    warnings: ['watch_only: only a quick read of this video was possible, so nothing here is measured — times, cuts and leg sides are estimates. Before planning any paid remake, ask the user to upload the video file. Never tell the user how the video was or was not fetched.'],
  }
}

// Golden set (spec §8a): the same pipeline on a local fixture file, no fetch or upload.
export async function breakDownLocalFile(filePath: string, tenantId?: string): Promise<Breakdown> {
  const p = await probe(filePath)
  return breakDownFetched({ fileId: '', filePath, durationS: p.durationS, width: p.width, height: p.height, fps: p.fps, hasAudio: p.hasAudio, caption: null, song: null, youtubeUrl: null, platform: 'local', tooLong: false }, tenantId)
}

async function breakDownFetched(video: FetchedVideo, tenantId?: string): Promise<Breakdown> {
  const warnings: string[] = []
  const [overview, cuts, sound] = await Promise.all([
    watchVideo(video, tenantId),
    aiService<CutsResult>('/media/cuts', { path: video.filePath }).catch((e: Error) => { logStep('cuts', e); warnings.push('cuts not measured this time'); return null }),
    aiService<SoundResult>('/media/sound', { path: video.filePath }).catch((e: Error) => { logStep('sound', e); warnings.push('sound not measured this time'); return null }),
  ])
  let hidden: HiddenCutsResult['hidden_cuts'] = []
  let hiddenFailed = false
  if (overview.change_style.includes('hidden_changes') && overview.looks.length > 1) {
    try {
      hidden = (await aiService<HiddenCutsResult>('/media/hidden-cuts', { path: video.filePath, looks: overview.looks.map((l) => ({ label: l.label, approx_start_s: l.approx_start_s, approx_end_s: l.approx_end_s })), subject_box: overview.subject_box ?? undefined })).hidden_cuts
    } catch (e) { hiddenFailed = true; logStep('hidden cuts', e); warnings.push('hidden cuts not measured this time') }
  }
  const measured = cuts !== null && sound !== null
  let refinedOverview: WatchOverview
  let posePending: Promise<PoseResult | null> = Promise.resolve(null)
  // Refining without knowing every cut and covered span would snap moments onto
  // a cut or the occluder and call them measured (review I1) — keep them unmeasured.
  if (cuts === null || hiddenFailed) {
    refinedOverview = {
      ...overview,
      moments: overview.moments.map((m) => ({ ...m, measured: false })),
      looks: overview.looks.map((l) => ({ ...l, moves: (l.moves ?? []).map((v) => ({ ...v, measured: false })) })),
    }
    warnings.push('moment times not measured (cuts or hidden cuts unavailable); they are estimates')
  } else {
    const exclude: Array<[number, number]> = [
      ...cuts.cuts.map((c) => [Math.round((c - 0.1) * 100) / 100, Math.round((c + 0.1) * 100) / 100] as [number, number]),
      ...cuts.fades,
      ...hidden.map((h) => h.covered_s),
    ]
    const r = await refineMoments(video.filePath, overview, exclude)
    refinedOverview = r.overview
    if (r.unmeasured) warnings.push(`${r.unmeasured} moment time(s) could not be measured and are estimates`)
    // Leg side and body angle are MEASURED from the frames; Gemini's reading was wrong
    // for most looks on the golden set (spec §8a: no paid step from a model's guess).
    // Started now, awaited after the shot descriptions: CPU pose overlaps the Gemini call.
    const spans = lookSpans(overview, hidden, video.durationS)
    if (spans.length) {
      posePending = aiService<PoseResult>('/media/pose', { path: video.filePath, looks: spans, exclude })
        .catch((e: Error) => { logStep('pose', e); warnings.push('body readings unavailable this time; leg sides are estimates'); return null })
    }
  }
  const bounds = mergeBounds(video.durationS, cuts?.cuts ?? [], hidden.map((h) => h.at_s), (cuts?.fades ?? []).map((f) => f[0]))
  let shots: Shot[]
  let soundArc = ''
  if (overview.change_style.length === 1 && overview.change_style[0] === 'near_still' && bounds.length === 2) {
    shots = [{ n: 1, start_s: 0, end_s: video.durationS, subject: overview.format, action: 'near-still', story_role: 'endcard' }]
    soundArc = overview.sound
  } else {
    let d: { shots: Shot[]; sound_arc: string } = { shots: [], sound_arc: '' }
    try {
      d = await describeShots(video, bounds, sound, tenantId)
    } catch (e) {
      // Keep the overview and measurements already paid for (review M3).
      logStep('shot descriptions', e); warnings.push('shot descriptions unavailable this time')
    }
    shots = fillMissingShots(bounds, d.shots)
    soundArc = d.sound_arc
    if (shots.some((s) => s.subject === 'unclear')) warnings.push('some shots were skipped by the watcher and are marked unclear')
  }
  const check = await checkShortShots(video, shots, tenantId)
  for (const f of check.fixes) {
    const s = shots.find((x) => x.n === f.n)
    if (s) s.checker_fix = { subject: f.subject }
  }
  if (check.status === 'unknown') warnings.push('short-shot picture check unavailable')
  const { filePath: _fp, ...videoOut } = video
  const soundOut = sound ? (({ curve_db: _c, ...rest }) => rest)(sound) : null
  const pose = await posePending
  const measuredLooks = new Map((pose?.looks ?? []).map((l) => [l.label, l]))
  refinedOverview = {
    ...refinedOverview,
    looks: refinedOverview.looks.map((l) => {
      const m = measuredLooks.get(l.label)
      const body = m ? { body: { people: m.people, no_person: m.no_person, start: m.main_start, end: m.main_end } } : {}
      return m && m.leg_side_end !== 'unknown'
        ? { ...l, ...body, leg_side: m.leg_side_end, leg_side_start: m.leg_side_start, leg_side_source: 'measured' as const, body_angle: m.body_angle_end }
        : { ...l, ...body, leg_side_source: 'gemini' as const }
    }),
  }
  return { video: videoOut, overview: refinedOverview, measured, pose, cuts, hidden_cuts: hidden, sound: soundOut, shots, sound_arc: soundArc, short_shot_check: { checked: check.checked, status: check.status }, warnings }
}

export const breakDownVideoTool = createTool({
  id: 'break_down_video',
  description: 'Break down a reference video completely from a link or an attached file: format, story, moments, each look (outfit, expression, poses, moves, leg side), props, setting, the trick, exact cuts and hidden cuts, exact sound timing, and every shot. Use this first when the user wants to clone or recreate a video. Over 90s: ask which part.',
  inputSchema: z.object({ url: linkSchema.optional(), fileId: z.string().optional() }),
  outputSchema: z.object({ success: z.boolean(), breakdown: z.any().optional(), error: z.string().optional() }),
  execute: async (input, execContext) => {
    const rc = execContext?.requestContext
    const idToken = rc?.get('idToken') as string | undefined
    const tenantId = rc?.get('tenantId') as string | undefined
    const sessionId = rc?.get('sessionId') as string | undefined
    const conversationId = (rc?.get('conversationId') as string | undefined) ?? sessionId
    if (!idToken || !sessionId || !conversationId) return { success: false, error: 'no_active_session' }
    try {
      return { success: true, breakdown: await breakDownVideo(input, { idToken, scopeId: tenantId ?? sessionId, conversationId }, tenantId) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
})
