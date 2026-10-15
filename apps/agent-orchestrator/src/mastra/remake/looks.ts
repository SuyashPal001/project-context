import type { Breakdown } from '../tools/videoBreakdown/breakDownVideo.js'
import { lookSpans } from '../tools/videoBreakdown/breakDownVideo.js'
import type { BodyReading } from '../tools/videoBreakdown/aiServiceClient.js'
import type { RemakeLook } from './types.js'

const raised = (b: BodyReading) => `${b.arms.left === 'raised'}${b.arms.right === 'raised'}`

/** The body visibly differs between a look's start and end (so an end still is needed). */
export function bodyChanged(a: BodyReading | null, b: BodyReading | null): boolean {
  if (!a || !b) return false
  return a.framing !== b.framing || a.orientation !== b.orientation || a.knees !== b.knees || a.knees_toward !== b.knees_toward || raised(a) !== raised(b)
}

export function remakeLooks(b: Breakdown): RemakeLook[] {
  const spans = new Map(lookSpans(b.overview, b.hidden_cuts, b.video.durationS).map((s) => [s.label, s]))
  const measured = new Map((b.pose?.looks ?? []).map((l) => [l.label, l]))
  return b.overview.looks.flatMap((l, i) => {
    const m = measured.get(l.label)
    const s = m ?? spans.get(l.label)
    if (!s || !(s.end_s > s.start_s)) return []
    const startS = s.start_s, endS = s.end_s
    const pad = Math.min(0.5, (endS - startS) / 4)
    const kf = m?.key_frames ?? []
    const start = m?.main_start ?? null, end = m?.main_end ?? null
    const moves = (l.moves ?? []).length + (b.pose?.moves ?? []).filter((x) => x.t_s >= startS && x.t_s < endS).length
    return [{
      n: i + 1, label: l.label, startS, endS,
      outfit: l.outfit ?? '', expression: l.expression ?? '', startPose: l.start_pose ?? '', endPose: l.end_pose ?? '',
      measured: l.measured ?? null, people: m?.people ?? null, noPerson: m?.no_person ?? null, start, end, moves,
      guideStartS: kf[0]?.t_s ?? startS + pad,
      guideEndS: kf.length ? kf[kf.length - 1].t_s : endS - pad,
      needsEndStill: moves > 0 || bodyChanged(start, end),
    }]
  })
}

export const personIn = (l: RemakeLook): boolean => (l.people ?? 0) > 0

/** Plain words for the user when a breakdown cannot be remade safely; null when it can. */
export function refuseReason(b: Breakdown): string | null {
  if (b.watch_only) return 'I only had a quick read of this video, so I can’t plan an exact remake from it. Please upload the video file here and I’ll break it down properly first.'
  if (b.video.tooLong) return 'This video is long. Tell me which part to remake first.'
  if (/split/i.test(b.overview.layout)) return 'Split-screen videos can’t be remade yet.'
  if (!b.pose) return 'I couldn’t read the body positions in this video this time. Please try again in a minute.'
  if (!remakeLooks(b).length) return 'I couldn’t find the separate parts of this video, so I can’t plan a remake.'
  return null
}

export function aspectOf(b: Breakdown): '9:16' | '16:9' | '1:1' {
  const { width: w, height: h } = b.video
  return h > w * 1.1 ? '9:16' : w > h * 1.1 ? '16:9' : '1:1'
}
