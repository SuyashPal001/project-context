// Which model animates each look, for how long, and the prompt, all from the plan and
// the measured readings (spec §5.4, rules 5, 6, 7.1, 7.2, 12).
import { personWords } from '../tools/videoBreakdown/measuredLine.js'
import { personIn, refOf } from './looks.js'
import { CAST_BY_IMAGE } from './prompts.js'
import type { Brand, PlanLine, RemakeLook, RemakePlan, StillResult } from './types.js'
import { usableStill } from './preview.js'
import { generateSeconds, clipFit, pickLength, WARM_UP_S, type ClipFit } from '../tools/clipTiming.js'

export const CLIP_FPS = 30
const VEO_SECONDS = [4, 6, 8] as const

export interface ClipSpec { look: RemakeLook; engine: 'veo' | 'omni' | 'none'; seconds: number; frames: number; start: string | null; end: string | null; reason?: string
  /** How the clip becomes its look (tools/clipTiming): retimed when the speed-up can't be seen, else trimmed at real speed. */
  fit?: ClipFit }

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

const usable = usableStill

export function clipSpecs(plan: RemakePlan, stills: StillResult[]): ClipSpec[] {
  const frames = lookFrames(plan)
  return [...plan.looks].sort((a, b) => a.startS - b.startS).map((look): ClipSpec => {
    const len = look.endS - look.startS
    const start = usable(stills.find((s) => s.look === look.n && s.kind === 'start'))
    const end = usable(stills.find((s) => s.look === look.n && s.kind === 'end'))
    const base = { look, frames: frames.get(look.n) ?? Math.round(len * CLIP_FPS), start, end }
    if (!start) return { ...base, engine: 'none', seconds: 0, end: null, reason: 'its still wasn’t made, so this part stays a still' }
    // Shared clip timing: a Veo length retimed only when the change can't be seen (the end still stays
    // the last frame), else the smallest covering length cut at real speed. No warm-up: frame 1 is the still.
    const veo = pickLength(len, VEO_SECONDS)
    if (end && veo) return { ...base, engine: 'veo', ...veo }
    if (len <= 10 + 1e-9) return { ...base, engine: 'omni', end: null, ...omniTiming(look) }
    return { ...base, engine: 'none', seconds: 0, end: null, reason: 'this part is too long to animate yet, so it stays a still' }
  })
}

/** An Omni clip's length and fit (also used when Veo refuses and Omni takes over): it covers its
 *  warm-up, which is trimmed off unless the look continues the previous part. */
export function omniTiming(look: RemakeLook): { seconds: number; fit: ClipFit } {
  const len = look.endS - look.startS
  const continuing = !!look.continues
  const seconds = Math.max(generateSeconds(len, { continuing })!, Math.ceil(len - 1e-9))
  return { seconds, fit: clipFit(seconds, len, continuing ? 0 : WARM_UP_S) }
}

const lineOf = (plan: RemakePlan, ref: string): PlanLine | undefined => plan.lines.find((l) => l.ref === ref)
const shown = (plan: RemakePlan, ref: string, original: string): string | null => {
  const l = lineOf(plan, ref)
  if (!l || l.action === 'keep') return original.trim() || null
  return l.action === 'swap' ? l.to?.trim() || null : null
}

/** Move times are look-relative. A retimed clip places each move at its scaled time; a trimmed clip
 *  keeps real times, shifted past the part trimmed off its start. */
const scaleTimes = (lines: string[], factor: number, shift = 0) =>
  lines.map((l) => l.replace(/^at (\d+(?:\.\d+)?)s/, (_m, t) => `at ${(Number(t) * factor + shift).toFixed(1)}s`))

/** `plain`: the plainer wording tried once after a content block (spec rule 11) — frames, moves
 *  and camera only; no person, body or expression description. */
export function clipPrompt(plan: RemakePlan, look: RemakeLook, _brand: Brand, engine: 'veo' | 'omni', clipSeconds?: number, plain = false, fit?: ClipFit): string {
  const len = look.endS - look.startS
  const trim = fit?.mode === 'trim' ? fit : null
  const factor = trim ? 1 : clipSeconds && len > 0 ? clipSeconds / len : 1
  const shift = trim?.startS ?? 0
  const i = refOf(look)
  const parts: string[] = [engine === 'veo'
    ? 'The first image is the first frame and the second image is the last frame; move naturally from one to the other.'
    : 'The image is the exact first frame; continue from it.']
  if (personIn(look) && !plain) {
    parts.push('Keep the same person, face, outfit and setting the whole time.')
    // Plain words, never the measured jargon: "knees fall to image-left, feet to image-right" made Omni twist her
    // legs under a long dress (fan run real24). The images carry the pose; the legs' side and her gaze are said simply.
    const legsMove = look.moveLines.some((m) => /\blegs?\b|knee|feet|foot/i.test(m))
    const side = look.start?.legs_toward
    if (!legsMove && side && side !== 'unknown') parts.push(`Her legs lie ${side === 'center' ? 'straight' : `to the ${side.replace('image-', '')}`} and stay still.`)
    if (look.start?.facing === 'front') parts.push('She looks into the camera, eyes on the lens.')
    const expression = shown(plan, `looks[${i}].expression`, look.expression)
    if (expression) parts.push(`Expression: ${expression}.`)
  }
  parts.push(look.moveLines.length ? `Movement (directions as the viewer sees the frame): ${scaleTimes(look.moveLines, factor, shift).join('; ')}.` : 'Hold the pose; only small natural movement of the head and hands.')
  parts.push(look.cameraLines.length ? `Camera: ${scaleTimes(look.cameraLines, factor, shift).join('; ')}.` : 'The camera stays still.')
  if (trim && clipSeconds && clipSeconds > shift + len + 0.05) parts.push(`Finish every move by ${(shift + len).toFixed(1)}s, then hold that last pose with only small natural motion until the end.`)
  parts.push('Add nothing that is not described here: no extra people, objects, effects, text, logos or flicker; no change of lighting.')
  return parts.join(' ')
}

/** What the prompt check reads: the same timed moves the prompt states, and no reference moments (a clip
 *  never describes them: dropped text and unbuilt tricks would block it, and the stills carry the rest). */
export function clipGateInput(plan: RemakePlan, look: RemakeLook, prompt: string, clipSeconds?: number, fit?: ClipFit) {
  const len = look.endS - look.startS
  const trim = fit?.mode === 'trim' ? fit : null
  const factor = trim ? 1 : clipSeconds && len > 0 ? clipSeconds / len : 1
  const i = refOf(look)
  const mine = plan.lines.filter((l) => l.ref.startsWith(`looks[${i}].`) || l.ref.startsWith('props['))
  return {
    prompt,
    planLine: [`clip of look ${look.n}`, ...(personIn(look) ? [CAST_BY_IMAGE] : []),
      // the gaze line was blocked as contradicting "gazing upward" in an overhead shot (fan run real25)
      ...(personIn(look) && look.start?.facing === 'front' ? ["her eyes on the camera are the original's gaze (when the camera is above her, looking up is looking at it)"] : []), ...mine.map((l) => `${l.ref}: ${l.action}${l.to ? ` to ${l.to}` : ''}${/\.(outfit|styling)$/.test(l.ref) ? ' (given by the start image, not described in words)' : ''}`)].join('; '),
    look: {
      expression: shown(plan, `looks[${i}].expression`, look.expression) ?? undefined, start_pose: look.startPose, end_pose: look.endPose,
      body_at_start: look.start ? personWords(look.start, null).join(', ') : undefined,
      body_at_end: look.end ? personWords(look.end, null).join(', ') : undefined,
      moves: scaleTimes(look.moveLines, factor, trim?.startS ?? 0),
      timing: 'move times are clip times: the clip is retimed or trimmed to the look afterwards',
    } as Record<string, unknown> & { expression?: string },
    startFrameObjects: plan.reference.props.flatMap((p, j) => shown(plan, `props[${j}]`, p.prop) ?? []),
    keyMoments: [] as string[],
  }
}
