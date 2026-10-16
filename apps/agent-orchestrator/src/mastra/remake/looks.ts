import type { Breakdown } from '../tools/videoBreakdown/breakDownVideo.js'
import { lookSpans, lookLabelOf, isContinuingPart } from '../tools/videoBreakdown/breakDownVideo.js'
import type { BodyReading } from '../tools/videoBreakdown/aiServiceClient.js'
import type { RemakeLook } from './types.js'

const AREA: Record<string, string> = { upper: 'upper body', lower: 'legs' }
const CAMERA: Record<string, string> = { 'pan-left': 'pans left', 'pan-right': 'pans right', 'tilt-up': 'tilts up', 'tilt-down': 'tilts down' }
const raised = (b: BodyReading) => `${b.arms.left === 'raised'}${b.arms.right === 'raised'}`

// Turned around: only when both ends were read (an unread side never buys an extra paid still).
const turned = (a: BodyReading, b: BodyReading) => !!a.facing && !!b.facing && a.facing !== 'unknown' && b.facing !== 'unknown' && a.facing !== b.facing

/** The body visibly differs between a look's start and end (so an end still is needed). */
export function bodyChanged(a: BodyReading | null, b: BodyReading | null): boolean {
  if (!a || !b) return false
  return a.framing !== b.framing || a.orientation !== b.orientation || turned(a, b) || a.knees !== b.knees || a.knees_toward !== b.knees_toward || raised(a) !== raised(b)
}

export function remakeLooks(b: Breakdown): RemakeLook[] {
  const spans = lookSpans(b.overview, b.hidden_cuts, b.video.durationS, b.cuts?.cuts ?? [])
  const measured = new Map((b.pose?.looks ?? []).map((l) => [l.label, l]))
  // One remake look per SHOT (a look split at a hard cut is two shots of one outfit look); `ref` is
  // the outfit look's index, which the plan lines use.
  const shots = b.pose?.looks?.length ? b.pose.looks : spans
  let n = 0
  return shots.flatMap((shot) => {
    const i = b.overview.looks.findIndex((x) => x.label === lookLabelOf(shot.label))
    const l = b.overview.looks[i]
    if (!l) return []
    const m = measured.get(shot.label)
    const s = m ?? shot
    if (!s || !(s.end_s > s.start_s)) return []
    const first = shot.label === l.label
    const continues = isContinuingPart(shot.label)
    // the shot right after this one continues it: this one must end on a still the next starts from
    const nextContinues = shots.some((x) => isContinuingPart(x.label) && Math.abs(x.start_s - shot.end_s) < 1e-6)
    const last = !shots.some((x) => x !== shot && lookLabelOf(x.label) === l.label && x.start_s > shot.start_s)
    const startS = s.start_s, endS = s.end_s
    const pad = Math.min(0.5, (endS - startS) / 4)
    const kf = m?.key_frames ?? []
    const start = m?.main_start ?? null, end = m?.main_end ?? null
    const moves = (l.moves ?? []).length + (b.pose?.moves ?? []).filter((x) => x.t_s >= startS && x.t_s < endS).length
    // Moves as plain lines with times from the look's start, for clip prompts (directions as the viewer sees the frame).
    const rel = (t: number) => `at ${Math.max(0, t - startS).toFixed(1)}s`
    const say = (d: string) => d.split(' + ').map((x) => x.replace('image-', '')).join(' and ')
    const measuredMoves = (b.pose?.moves ?? []).filter((x) => x.t_s >= startS && x.t_s < endS)
      .map((x) => `${rel(x.t_s)}: ${AREA[x.area] ?? x.area} moves ${say(x.direction)}`)
    const describedMoves = (l.moves ?? []).filter((x) => x.t_s >= startS && x.t_s < endS)
      .map((x) => `${rel(x.t_s)}: ${x.limb}: ${x.how} (${say(x.direction)})`)
    const cameraLines = (b.pose?.camera_moves ?? []).filter((x) => x.t_s >= startS && x.t_s < endS)
      .map((x) => `${rel(x.t_s)}: the camera ${CAMERA[x.direction] ?? x.direction}`)
    return [{
      n: ++n, ref: i, label: shot.label, startS, endS,
      outfit: l.outfit ?? '', expression: l.expression ?? '', startPose: first ? l.start_pose ?? '' : '', endPose: last ? l.end_pose ?? '' : '',
      measured: l.measured ?? null, people: m?.people ?? null, noPerson: m?.no_person ?? null, start, end, moves,
      moveLines: [...measuredMoves, ...describedMoves], cameraLines,
      measuredPeople: m?.people != null && !(m.people === 0 && (m.people_max ?? 0) > 0),
      guideStartS: kf[0]?.t_s ?? startS + pad,
      guideEndS: kf.length ? kf[kf.length - 1].t_s : endS - pad,
      needsEndStill: nextContinues || moves > 0 || bodyChanged(start, end),
      ...(continues ? { continues: true } : {}),
    }]
  })
}

export const personIn = (l: RemakeLook): boolean => (l.people ?? 0) > 0
/** The plan-line index of a look's outfit look (two shots of one outfit share it). */
export const refOf = (l: RemakeLook): number => l.ref ?? l.n - 1

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
