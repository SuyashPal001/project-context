// Which model animates each look, for how long, and the prompt, all from the plan and
// the measured readings (spec §5.4, rules 5, 6, 7.1, 7.2, 12).
import { personWords, plainBody } from '../tools/videoBreakdown/measuredLine.js'
import type { LookDirection } from '../tools/lookDirection.js'
import { personIn, refOf } from './looks.js'
import { CAST_BY_IMAGE } from './prompts.js'
import type { Brand, PlanLine, RemakeLook, RemakePlan, StillResult } from './types.js'
import { usableStill } from './preview.js'
import { generateSeconds, clipFit, pickLength, WARM_UP_S, type ClipFit } from '../tools/clipTiming.js'

export const CLIP_FPS = 30
const VEO_SECONDS = [4, 6, 8] as const

export interface ClipSpec { look: RemakeLook; engine: 'veo' | 'omni' | 'none'; seconds: number; frames: number; start: string | null; end: string | null; reason?: string
  /** How the clip becomes its look (tools/clipTiming): retimed when the speed-up can't be seen, else trimmed at real speed. */
  fit?: ClipFit
  /** the photographer's direction read from the original look (tools/lookDirection) */
  direction?: LookDirection }

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
    // a person is Omni from the start photo, v12's way (Veo's in-between splayed her knees, fan run real25)
    if (end && veo && !personIn(look)) return { ...base, engine: 'veo', ...veo }
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
/** The moves said in words ("at 1.3s: arm/hand: raises the remote (up)"); a measured motion reading ("at 3.7s:
 *  legs moves up") of a top-down shot made Veo yank a knee up and splay her legs (fan run real25). */
const describedMoves = (lines: string[]): string[] => lines.filter((l) => /^at [\d.]+s: [^:]+: /.test(l))

export function clipPrompt(plan: RemakePlan, look: RemakeLook, _brand: Brand, engine: 'veo' | 'omni', clipSeconds?: number, plain = false, fit?: ClipFit, direction?: LookDirection | null): string {
  const len = look.endS - look.startS
  const trim = fit?.mode === 'trim' ? fit : null
  const factor = trim ? 1 : clipSeconds && len > 0 ? clipSeconds / len : 1
  const shift = trim?.startS ?? 0
  const i = refOf(look)
  const person = personIn(look) && !plain
  // A person is v12's way (the user: "v12 poses were so on point"): a fashion lookbook line from the start photo,
  // the original's moves in plain words, the legs' change of side, then holding the pose. Veo's in-between and
  // measured motion lines ("at 3.7s: legs moves up") splayed her knees (fan run real25).
  const parts: string[] = person ? ['Fashion lookbook shot.'] : []
  parts.push(engine === 'veo'
    ? 'The first image is the first frame and the second image is the last frame; move naturally from one to the other.'
    : 'The image is the exact first frame; continue from it.')
  const moves = describedMoves(look.moveLines)
  if (person) {
    parts.push('Keep the same person, face, outfit and setting the whole time.')
    // directed like v12 by hand (tools/lookDirection): her moves and where the objects rest, read from the original
    if (direction) {
      const sides = (t: string) => t.replace(/\bthe image-(left|right)\b/g, 'the $1 side of the image').replace(/\bimage-(left|right)\b/g, 'the $1 side of the image').replace(/[.\s]+$/, '')
      parts.push(direction.moves ? `Then ${sides(direction.moves).replace(/^\w/, (c) => c.toLowerCase())}, and holds the pose.` : 'She holds the pose, breathing softly.')
      if (direction.objects) parts.push(`${sides(direction.objects).replace(/^\w/, (c) => c.toUpperCase())} and stays there.`)
    } else if (moves.length) parts.push(`Movement (directions as the viewer sees the frame): ${scaleTimes(moves, factor, shift).join('; ')}.`)
    const from = look.start ? legSide(look.start) : null
    const to = look.end ? legSide(look.end) : null
    if (direction) { /* said above */ } else if (to && to !== 'center' && to !== from) parts.push(`${moves.length ? 'Then she' : 'She'} slowly slides both legs together to the ${to.replace('image-', '')} side of the image${look.end?.knees === 'bent' ? ', knees softly bent,' : ''} and holds the pose.`)
    else parts.push('She holds the pose, breathing softly.')
    // the user (2026-10-17): "energy of the influencer, pulling towards, not blank, not too much giggling... slay"
    if (look.start?.facing !== 'back') parts.push('Confident influencer energy: she owns the camera, eyes locked on the lens with a subtle knowing look; poised and magnetic, never blank, no big smile or giggling; she does not speak.')
    parts.push('The camera is locked off and never moves or zooms; her whole body stays in frame. All directions are as seen in the image.')
  } else {
    parts.push(moves.length ? `Movement (directions as the viewer sees the frame): ${scaleTimes(moves, factor, shift).join('; ')}.` : 'Hold the pose; only small natural movement of the head and hands.')
    parts.push(look.cameraLines.length ? `Camera: ${scaleTimes(look.cameraLines, factor, shift).join('; ')}.` : 'The camera stays still.')
  }
  if (trim && clipSeconds && clipSeconds > shift + len + 0.05) parts.push(`Finish every move by ${(shift + len).toFixed(1)}s, then hold that last pose with only small natural motion until the end.`)
  parts.push('Add nothing that is not described here: no extra people, objects, effects, text, logos or flicker; no change of lighting.')
  return parts.join(' ')
}

/** Which way the legs lie, as the viewer sees it. */
const legSide = (b: NonNullable<RemakeLook['start']>): string | null => {
  const s = b.legs_toward === 'image-left' || b.legs_toward === 'image-right' ? b.legs_toward : b.knees_toward
  return s === 'image-left' || s === 'image-right' || s === 'center' ? s : null
}

/** What the prompt check reads: the same timed moves the prompt states, and no reference moments (a clip
 *  never describes them: dropped text and unbuilt tricks would block it, and the stills carry the rest). */
export function clipGateInput(plan: RemakePlan, look: RemakeLook, prompt: string, clipSeconds?: number, fit?: ClipFit, direction?: LookDirection | null) {
  const len = look.endS - look.startS
  const trim = fit?.mode === 'trim' ? fit : null
  const factor = trim ? 1 : clipSeconds && len > 0 ? clipSeconds / len : 1
  const i = refOf(look)
  const mine = plan.lines.filter((l) => l.ref.startsWith(`looks[${i}].`) || l.ref.startsWith('props['))
  return {
    prompt,
    planLine: [`clip of look ${look.n}`, ...(personIn(look) ? [CAST_BY_IMAGE] : []),
      // the gaze line was blocked as contradicting "gazing upward" in an overhead shot (fan run real25)
      ...(personIn(look) && look.start?.facing === 'front' ? ["her eyes on the camera are the original's gaze (when the camera is above her, looking up is looking at it)"] : []),
      // the user asked for it (2026-10-17: "energy of the influencer... slay"); it replaces the plain expression line
      ...(personIn(look) ? ['the influencer energy line is the house style for a person on camera, not invented content; it stands in for the expression'] : []),
      ...(direction ? [`the photographer's direction read from the original look (not invented): start: ${direction.start}; moves: ${direction.moves || 'holds still'}; objects: ${direction.objects || 'none'}`] : []), ...mine.map((l) => `${l.ref}: ${l.action}${l.to ? ` to ${l.to}` : ''}${/\.(outfit|styling)$/.test(l.ref) ? ' (given by the start image, not described in words)' : ''}`)].join('; '),
    look: {
      expression: shown(plan, `looks[${i}].expression`, look.expression) ?? undefined, start_pose: look.startPose, end_pose: look.endPose,
      body_at_start: look.start ? personWords(look.start, null).join(', ') : undefined,
      body_at_end: look.end ? personWords(look.end, null).join(', ') : undefined,
      moves: scaleTimes(describedMoves(look.moveLines), factor, trim?.startS ?? 0),
      timing: 'move times are clip times: the clip is retimed or trimmed to the look afterwards',
    } as Record<string, unknown> & { expression?: string },
    startFrameObjects: plan.reference.props.flatMap((p, j) => shown(plan, `props[${j}]`, p.prop) ?? []),
    keyMoments: [] as string[],
  }
}
