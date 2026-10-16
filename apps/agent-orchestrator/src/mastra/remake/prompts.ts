// Every paid prompt is BUILT here from plan lines and measured readings (spec rule 7.2),
// never written freehand. Words are general: any reel, any number of people.
import { personWords } from '../tools/videoBreakdown/measuredLine.js'
import { personIn, refOf } from './looks.js'
import type { Brand, PlanLine, RemakeLook, RemakePlan } from './types.js'

const lineOf = (plan: RemakePlan, ref: string): PlanLine | undefined => plan.lines.find((l) => l.ref === ref)

/** What the remake shows for a ref: the original (keep), the replacement (swap), or nothing (drop). */
function shown(plan: RemakePlan, ref: string, original: string): string | null {
  const l = lineOf(plan, ref)
  if (!l || l.action === 'keep') return original.trim() || null
  return l.action === 'swap' ? l.to?.trim() || null : null
}

// Scene objects by name only: where they sit comes from the guide picture. Position words cover the
// whole reel ("beside her, then in her hand") and drew one object twice (fan reel, 2026-10-16).
// A trick object (a fan blade, a wiping hand) is added over the finished video, never drawn in a still.
// A prop's "when" is the watch model's free text ("0:00 - 0:03.5", "3.7s-14s", "Throughout video").
// Two times are a range; anything else (no times, one time) keeps the prop everywhere, as before.
function whenRange(when: string): [number, number] | null {
  const t = [...when.matchAll(/(\d+):(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*s\b/g)].map((m) => (m[3] ? Number(m[3]) : Number(m[1]) * 60 + Number(m[2])))
  return t.length >= 2 ? [Math.min(t[0], t[1]), Math.max(t[0], t[1])] : null
}
// The watch model's times are rough; a little slack, but not across a cut (metro: earbuds from 3.7s drew into the 3.3s still).
const SLACK_S = 0.25
/** Props in view at time t (metro A/B: every prop went into every still, so a phone from shot 1
 *  appeared in the selfie shots and earbuds from the selfie shots appeared in shot 1). */
export function propsAt(plan: RemakePlan, t: number): string[] {
  return plan.reference.props.flatMap((p, i) => {
    if (p.trick) return []
    const r = whenRange(p.when ?? '')
    if (r && (t < r[0] - SLACK_S || t > r[1] + SLACK_S)) return []
    return shown(plan, `props[${i}]`, p.prop) ?? []
  })
}
const stillTime = (look: RemakeLook, kind: 'start' | 'end'): number => (kind === 'start' ? look.guideStartS : look.guideEndS)
// An end still with no end pose of its own (the first part of a split shot) says no pose: repeating the
// start pose asked for the same picture twice (metro A/B: both selfie stills came out identical).
const poseOf = (look: RemakeLook, kind: 'start' | 'end'): string => (kind === 'start' ? look.startPose : look.endPose)
const trickProps = (plan: RemakePlan): string[] => plan.reference.props.filter((p) => p.trick).map((p) => p.prop)

export function usesProduct(plan: RemakePlan, brand: Brand): boolean {
  const name = brand.product.toLowerCase()
  return plan.lines.some((l) => l.action === 'swap' && !!l.to && l.to.toLowerCase().includes(name))
}

export function castSheetPrompt(castTo: string): string {
  return `One photo split into three equal side-by-side panels, numbered 1, 2 and 3 in small grey corner numbers. Each panel shows a different new person who fits: ${castTo}. Each is full body, standing, facing the camera, neutral expression, plain light-grey background, soft natural light. Three clearly different faces. Not any real or famous person. No other text.`
}

/** The chosen person's continuity bible: what every still is anchored to (face consistency is hard).
 *  It follows the TVC character sheet (tvc-character-creator/director.md) without the costume
 *  sections and lock: a remake swaps the outfit per look, so the casting outfit must not be locked
 *  into every still. No profile box either (no guessed text about the person). */
export const REFERENCE_SHEET_PROMPT = "A professional CHARACTER REFERENCE SHEET — a continuity bible for AI video production — of this exact person, on a clean white page with thin grey panel borders and small, neat, correctly spelled uppercase section labels. No personal name anywhere on the page. Numbered sections: 1. FULL-BODY TURNAROUND — the largest panel: front, 3/4 view, side view and back view, head to feet, on a light-grey studio background. 2. FACE & IDENTITY DETAILS — front, 3/4 view and profile close-ups. 3. EXPRESSION SHEET — eight head-and-shoulders crops in two rows: neutral, happy, angry, sad, surprised, worried, confident, determined, each labelled. Every expression is subtle and believable, the way a real actor plays it to camera in a live-action commercial: real skin creasing around the eyes and mouth, natural asymmetry, the same real-camera skin texture as the image — never exaggerated, theatrical or cartoonish. 4. POSE & BODY LANGUAGE — six full-body poses: neutral standing, walking, sitting on a white cube, relaxed, tense, action-ready, each labelled. 5. DO NOT CHANGE — a bordered lock panel with a small padlock icon reading: Face · Identity · Skin tone · Age · Hair · Body shape · Proportions. No redesign, no beautifying, no aging, no stylizing, no simplifying. The same face, hair and body in every panel, in the same plain clothes as the image, photoreal, even soft studio light, tasteful and ad-appropriate, crisp legible text, no other people, no watermark."

/** The words of one still, shared by a single still and a photo of a board: the person lines (pose,
 *  body, others, outfit, expression), the setting, the props in view and what not to draw. */
export function stillBits(plan: RemakePlan, look: RemakeLook, kind: 'start' | 'end') {
  const i = refOf(look)
  const body = kind === 'start' ? look.start : look.end
  const pose = poseOf(look, kind)
  const outfit = shown(plan, `looks[${i}].outfit`, look.outfit)
  const expression = shown(plan, `looks[${i}].expression`, look.expression)
  const person: string[] = []
  if (pose) person.push(`Pose: ${pose}.`)
  const words = body ? personWords(body, null) : []
  if (words.length) person.push(`Body: ${words.join(', ')}.`)
  if (look.people && look.people > 1) person.push(`${look.people - 1} other people are in the shot as in the guide, each a different new person.`)
  if (outfit) person.push(`Outfit: ${outfit}.`)
  if (expression) person.push(`Expression: ${expression}.`)
  const setting = shown(plan, 'setting', plan.reference.setting)
  return {
    person,
    setting: setting ? `Setting: ${setting}.` : '',
    // A kept setting IS the guide frame's setting; excluding it contradicted the plan (real checker, 2026-10-16).
    settingKept: (lineOf(plan, 'setting')?.action ?? 'keep') === 'keep',
    props: propsAt(plan, stillTime(look, kind)),
    trick: trickProps(plan),
  }
}

export function stillPrompt(plan: RemakePlan, look: RemakeLook, kind: 'start' | 'end', brand: Brand, hasProductPhoto: boolean): string {
  const person = personIn(look)
  const b = stillBits(plan, look, kind)
  const parts: string[] = []
  if (person) {
    parts.push('The person is the person in the first image: same face, hair and body.')
    parts.push(b.settingKept
      ? 'Copy ONLY the body pose, camera framing, setting and where objects sit from the second image; not its person, face, outfit, accessories or any text.'
      : 'Copy ONLY the body pose, camera framing and where objects sit from the second image; not its person, face, outfit, accessories, setting or any text.')
    parts.push(...b.person)
  } else {
    parts.push('No person in this image.')
    parts.push('Copy ONLY the layout and camera angle from the first image; not its objects, text or logos.')
  }
  if (b.setting) parts.push(b.setting)
  if (b.props.length) parts.push(`Objects: ${b.props.join('; ')}.`)
  if (b.trick.length) parts.push(`Do not draw: ${b.trick.join('; ')}.`)
  if (hasProductPhoto && usesProduct(plan, brand)) parts.push(`The ${person ? 'third' : 'second'} image is the brand's product: show it exactly as it is, same shape, colour and label.`)
  parts.push('Add nothing that is not described here: no extra people, effects, text or logos.')
  return parts.join(' ')
}

/** The person's identity is carried by the cast image, never by words in the prompt, so the
 *  cast description must not be a line the prompt is checked against (live run 08466630:
 *  "missing: A charismatic man…" blocked a correct still). */
export const CAST_BY_IMAGE = 'the person: a new person, given by the first reference image (not described in words)'

export function stillGateInput(plan: RemakePlan, look: RemakeLook, kind: 'start' | 'end', prompt: string) {
  const i = refOf(look)
  const mine = plan.lines.filter((l) => l.ref.startsWith(`looks[${i}].`) || l.ref === 'setting' || l.ref.startsWith('props['))
  const trickRef = (ref: string) => { const m = /^props\[(\d+)\]$/.exec(ref); return !!m && !!plan.reference.props[Number(m[1])]?.trick }
  // A trick object is added over the finished video, so a still that leaves it out is right (fan rerun: "missing: props[1]").
  const planLine = [`${kind} still of look ${look.n}`, ...(personIn(look) ? [CAST_BY_IMAGE] : []), ...mine.map((l) => `${l.ref}: ${l.action}${l.to ? ` to ${l.to}` : ''}${l.why ? ` (${l.why})` : ''}${trickRef(l.ref) ? ' (the trick: added over the finished video, never drawn in a still)' : ''}`)].join('; ')
  // Only THIS still's body (start or end): the look-level "Measured:" line describes the end and
  // made a correct start-still prompt read as a contradiction (live run 08466630).
  const body = kind === 'start' ? look.start : look.end
  const pose = poseOf(look, kind)
  return {
    prompt, planLine,
    look: { expression: shown(plan, `looks[${i}].expression`, look.expression) ?? undefined, pose, body_measured: body ? personWords(body, null).join(', ') : undefined } as Record<string, unknown> & { expression?: string },
    startFrameObjects: propsAt(plan, stillTime(look, kind)),
    keyMoments: [] as string[],
  }
}
