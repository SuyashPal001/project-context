// Which model animates each look, for how long, and the prompt, all from the plan and
// the measured readings (spec §5.4, rules 5, 6, 7.1, 7.2, 12).
import { personWords } from '../tools/videoBreakdown/measuredLine.js'
import { personIn } from './looks.js'
import type { Brand, PlanLine, RemakeLook, RemakePlan, StillResult } from './types.js'

export const CLIP_FPS = 30
const VEO_SECONDS = [4, 6, 8] as const

export interface ClipSpec { look: RemakeLook; engine: 'veo' | 'omni' | 'none'; seconds: number; frames: number; start: string | null; end: string | null; reason?: string }

/** Frames per look from cumulative end edges, so the total is exactly round(total × 30)
 *  and any gap or overlap between measured spans is absorbed by the following look. */
export function lookFrames(plan: RemakePlan): Map<number, number> {
  const out = new Map<number, number>()
  let prev = 0
  for (const l of [...plan.looks].sort((a, b) => a.startS - b.startS)) {
    const edge = Math.round(l.endS * CLIP_FPS + 1e-9)
    out.set(l.n, edge - prev)
    prev = edge
  }
  return out
}

const usable = (s: StillResult | undefined) => (s && s.fileId && (s.status === 'passed' || s.status === 'unchecked') ? s.fileId : null)

export function clipSpecs(plan: RemakePlan, stills: StillResult[]): ClipSpec[] {
  const frames = lookFrames(plan)
  return [...plan.looks].sort((a, b) => a.startS - b.startS).map((look): ClipSpec => {
    const len = look.endS - look.startS
    const start = usable(stills.find((s) => s.look === look.n && s.kind === 'start'))
    const end = usable(stills.find((s) => s.look === look.n && s.kind === 'end'))
    const base = { look, frames: frames.get(look.n) ?? Math.round(len * CLIP_FPS), start, end }
    if (!start) return { ...base, engine: 'none', seconds: 0, end: null, reason: 'its still wasn’t made, so this part stays a still' }
    // The Veo length nearest the look (the clip is retimed to the look, so the end still is
    // always its last frame); a look over 8s can't be one Veo clip.
    const veo = len <= 8 + 1e-9 ? [...VEO_SECONDS].sort((x, y) => Math.abs(x - len) - Math.abs(y - len) || y - x)[0] : undefined
    if (end && veo) return { ...base, engine: 'veo', seconds: veo }
    if (len <= 10 + 1e-9) return { ...base, engine: 'omni', seconds: Math.min(10, Math.max(3, Math.ceil(len - 1e-9))), end: null }
    return { ...base, engine: 'none', seconds: 0, end: null, reason: 'this part is too long to animate yet, so it stays a still' }
  })
}

const lineOf = (plan: RemakePlan, ref: string): PlanLine | undefined => plan.lines.find((l) => l.ref === ref)
const shown = (plan: RemakePlan, ref: string, original: string): string | null => {
  const l = lineOf(plan, ref)
  if (!l || l.action === 'keep') return original.trim() || null
  return l.action === 'swap' ? l.to?.trim() || null : null
}

/** Move times are look-relative; the clip is `clipSeconds` long and is retimed to the look,
 *  so the model must place each move at its scaled time. */
const scaleTimes = (lines: string[], factor: number) =>
  lines.map((l) => l.replace(/^at (\d+(?:\.\d+)?)s/, (_m, t) => `at ${(Number(t) * factor).toFixed(1)}s`))

export function clipPrompt(plan: RemakePlan, look: RemakeLook, _brand: Brand, engine: 'veo' | 'omni', clipSeconds?: number): string {
  const len = look.endS - look.startS
  const factor = clipSeconds && len > 0 ? clipSeconds / len : 1
  const i = look.n - 1
  const parts: string[] = [engine === 'veo'
    ? 'The first image is the first frame and the second image is the last frame; move naturally from one to the other.'
    : 'The image is the exact first frame; continue from it.']
  if (personIn(look)) {
    parts.push('Keep the same person, face, outfit and setting the whole time.')
    if (look.start) parts.push(`At the start: ${personWords(look.start, null).join(', ')}.`)
    if (look.end && engine === 'veo') parts.push(`At the end: ${personWords(look.end, null).join(', ')}.`)
    const expression = shown(plan, `looks[${i}].expression`, look.expression)
    if (expression) parts.push(`Expression: ${expression}.`)
  }
  parts.push(look.moveLines.length ? `Movement (directions as the viewer sees the frame): ${scaleTimes(look.moveLines, factor).join('; ')}.` : 'Hold the pose with only small natural motion.')
  parts.push(look.cameraLines.length ? `Camera: ${scaleTimes(look.cameraLines, factor).join('; ')}.` : 'The camera stays still.')
  parts.push('Add nothing that is not described here: no extra people, objects, effects, text, logos or flicker; no change of lighting.')
  return parts.join(' ')
}

export function clipGateInput(plan: RemakePlan, look: RemakeLook, prompt: string) {
  const i = look.n - 1
  const mine = plan.lines.filter((l) => l.ref.startsWith(`looks[${i}].`) || l.ref === 'cast' || l.ref.startsWith('props['))
  return {
    prompt,
    planLine: [`clip of look ${look.n}`, ...mine.map((l) => `${l.ref}: ${l.action}${l.to ? ` to ${l.to}` : ''}`)].join('; '),
    look: { expression: shown(plan, `looks[${i}].expression`, look.expression) ?? undefined, start_pose: look.startPose, end_pose: look.endPose, measured: look.measured, moves: look.moveLines } as Record<string, unknown> & { expression?: string },
    startFrameObjects: plan.reference.props.flatMap((p, j) => shown(plan, `props[${j}]`, p.prop) ?? []),
    keyMoments: plan.reference.moments.filter((m) => m.t_s >= look.startS && m.t_s < look.endS).map((m) => m.what),
  }
}
