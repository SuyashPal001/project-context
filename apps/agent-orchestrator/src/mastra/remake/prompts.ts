// Every paid prompt is BUILT here from plan lines and measured readings (spec rule 7.2),
// never written freehand. Words are general: any reel, any number of people.
import { personWords, plainBody } from '../tools/videoBreakdown/measuredLine.js'
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
  return plan.reference.props.flatMap((p, i) => (p.trick || !inView(p.when, t) ? [] : shown(plan, `props[${i}]`, p.prop) ?? []))
}
/** Every object of the reel whatever its guessed time (never the trick): the missing-object check counts them in
 *  the original's frame, so what the frame really shows decides (the watch model put the fan reel's remote at
 *  0-5s only; it lies by her hand in every look). */
export function reelProps(plan: RemakePlan): string[] {
  return plan.reference.props.flatMap((p, i) => (p.trick ? [] : shown(plan, `props[${i}]`, p.prop) ?? []))
}
function inView(when: string | undefined, t: number): boolean {
  const r = whenRange(when ?? '')
  return !r || (t >= r[0] - SLACK_S && t <= r[1] + SLACK_S)
}
/** Other characters on screen at time t that the plan casts as new people (a dropped one is left out). */
export function charactersAt(plan: RemakePlan, t: number): Array<{ i: number; who: string; to: string }> {
  return (plan.reference.characters ?? []).flatMap((c, i) => {
    const l = lineOf(plan, `characters[${i}]`)
    if (!l || l.action !== 'swap' || !l.to) return []
    const r = whenRange(c.when)
    if (r && (t < r[0] - SLACK_S || t > r[1] + SLACK_S)) return []
    return [{ i, who: c.who, to: l.to }]
  })
}
/** Image number of each character's portrait among a still's references (character index -> image n). */
export type CharacterImages = Map<number, number>
export const stillTime = (look: RemakeLook, kind: 'start' | 'end'): number => (kind === 'start' ? look.guideStartS : look.guideEndS)
// An end still with no end pose of its own (the first part of a split shot) says no pose: repeating the
// start pose asked for the same picture twice (metro A/B: both selfie stills came out identical).
const poseOf = (look: RemakeLook, kind: 'start' | 'end'): string => (kind === 'start' ? look.startPose : look.endPose)
export const trickProps = (plan: RemakePlan): string[] => plan.reference.props.filter((p) => p.trick).map((p) => p.prop)

export function usesProduct(plan: RemakePlan, brand: Brand): boolean {
  const name = brand.product.toLowerCase()
  return plan.lines.some((l) => l.action === 'swap' && !!l.to && l.to.toLowerCase().includes(name))
}

export function castSheetPrompt(castTo: string, note?: string): string {
  return `One photo split into three equal side-by-side panels, numbered 1, 2 and 3 in small grey corner numbers. Each panel shows a different new person who fits: ${castTo}. ${note?.trim() ? `The user asked for: ${note.trim().replace(/[.\s]+$/, '')}. ` : ''}Each is clearly an adult, mid-20s or older. They are attractive, camera-ready models, as cast for a fashion ad. Each is full body, standing, facing the camera, a relaxed confident expression, with groomed hair worn simply, light polished makeup, no jewellery, plain neutral clothes; plain light-grey background, soft flattering studio light. Three clearly different faces. Not any real or famous person. No other text.`
}

/** The chosen person's continuity bible: what every still is anchored to (face consistency is hard).
 *  It follows the TVC character sheet (tvc-character-creator/director.md) without the costume
 *  sections and lock: a remake swaps the outfit per look, so the casting outfit must not be locked
 *  into every still. No profile box either (no guessed text about the person). */
export const REFERENCE_SHEET_PROMPT = "A professional CHARACTER REFERENCE SHEET — a continuity bible for AI video production — of this exact person, on a clean white page with thin grey panel borders and small, neat, correctly spelled uppercase section labels. No personal name anywhere on the page. Numbered sections: 1. FULL-BODY TURNAROUND — the largest panel: front, 3/4 view, side view and back view, head to feet, on a light-grey studio background. 2. FACE & IDENTITY DETAILS — front, 3/4 view and profile close-ups. 3. EXPRESSION SHEET — eight head-and-shoulders crops in two rows: neutral, happy, angry, sad, surprised, worried, confident, determined, each labelled. Every expression is subtle and believable, the way a real actor plays it to camera in a live-action commercial: real skin creasing around the eyes and mouth, natural asymmetry, the same real-camera skin texture as the image — never exaggerated, theatrical or cartoonish. 4. POSE & BODY LANGUAGE — six full-body poses: neutral standing, walking, sitting on a white cube, relaxed, tense, action-ready, each labelled. 5. DO NOT CHANGE — a bordered lock panel with a small padlock icon reading: Face · Identity · Skin tone · Age · Body shape · Proportions. No redesign, no beautifying, no aging, no simplifying. Hair, jewellery and makeup are styling: shown plainly here, they change per look. The same face, hair and body in every panel, in the same plain clothes as the image, photoreal, even soft studio light, tasteful and ad-appropriate, crisp legible text, no other people, no watermark."

/** The words of one still, shared by a single still and a photo of a board: the person lines (pose,
 *  body, others, outfit, expression), the setting, the props in view and what not to draw. */
export function stillBits(plan: RemakePlan, look: RemakeLook, kind: 'start' | 'end', characters?: CharacterImages) {
  const i = refOf(look)
  const body = kind === 'start' ? look.start : look.end
  const pose = poseOf(look, kind)
  const outfit = shown(plan, `looks[${i}].outfit`, look.outfit)
  const styling = stylingOf(plan, look)
  const expression = shown(plan, `looks[${i}].expression`, look.expression)
  const person: string[] = []
  if (pose) person.push(`Pose: ${pose}.`)
  // plain fashion words (the measured jargon twisted her legs, fan runs real24/25)
  const words = body ? plainBody(body) : ''
  if (words) person.push(`Body: ${words}.`)
  if (look.people && look.people > 1) person.push(`${look.people - 1} other people are in the shot as in the guide, each a different new person.`)
  if (outfit) person.push(`Outfit: ${outfit}.`)
  if (styling) person.push(`Styling: ${styling}.`)
  if (expression) person.push(`Expression: ${expression}.`)
  for (const c of charactersAt(plan, stillTime(look, kind))) {
    const n = characters?.get(c.i)
    if (n) person.push(`The ${c.who} is the person in image ${n}: same face and hair; not the person in the first image.`)
  }
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

export function stillPrompt(plan: RemakePlan, look: RemakeLook, kind: 'start' | 'end', brand: Brand, hasProductPhoto: boolean, characters?: CharacterImages): string {
  const person = personIn(look)
  const b = stillBits(plan, look, kind, characters)
  const parts: string[] = []
  if (person) {
    // the colour too: a styling line restyles the hair, never recolours it (fan run real18: brown, highlighted)
    parts.push('The person is the person in the first image: same face, hair colour and body.')
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
/** One portrait of another character, made after the lead is picked (gated like every paid image). */
export const characterPortraitPrompt = (to: string): string =>
  `One photo of one new person who fits: ${to}; clearly an adult, mid-20s or older. Head and shoulders, facing the camera, neutral expression, plain light-grey background, soft natural light, photoreal. Not any real or famous person. No text.`

export const CAST_BY_IMAGE = 'the person: a new person, given by the first reference image (not described in words)'

export function stillGateInput(plan: RemakePlan, look: RemakeLook, kind: 'start' | 'end', prompt: string, characters?: CharacterImages) {
  const i = refOf(look)
  // Only the props in view at this still: an off-screen prop's line read as "missing" (metro rerun v7).
  const t = stillTime(look, kind)
  const propInView = (ref: string) => { const m = /^props\[(\d+)\]$/.exec(ref); return !m || inView(plan.reference.props[Number(m[1])]?.when, t) }
  const mine = plan.lines.filter((l) => l.ref.startsWith(`looks[${i}].`) || l.ref === 'setting' || (l.ref.startsWith('props[') && propInView(l.ref)))
  const trickRef = (ref: string) => { const m = /^props\[(\d+)\]$/.exec(ref); return !!m && !!plan.reference.props[Number(m[1])]?.trick }
  // A trick object is added over the finished video, so a still that leaves it out is right (fan rerun: "missing: props[1]").
  // A character in view is given by their portrait, like the lead: never a line the prompt is checked against in words.
  const others = charactersAt(plan, stillTime(look, kind)).filter((c) => characters?.get(c.i)).map((c) => `characters[${c.i}]: swap to ${c.to} (given by image ${characters!.get(c.i)}, not described in words)`)
  const planLine = [`${kind} still of look ${look.n}`, ...(personIn(look) ? [CAST_BY_IMAGE] : []), ...others, ...mine.map((l) => `${l.ref}: ${l.action}${l.to ? ` to ${l.to}` : ''}${l.why ? ` (${l.why})` : ''}${trickRef(l.ref) ? ' (the trick: added over the finished video, never drawn in a still)' : ''}`)].join('; ')
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

/** A look's styling (hair, jewellery, makeup) as the plan has it; '' when none. */
export function stylingOf(plan: RemakePlan, look: RemakeLook): string {
  const l = plan.lines.find((x) => x.ref === `looks[${refOf(look)}].styling`)
  if (!l || l.action === 'keep') return (look.styling ?? '').trim()
  return l.action === 'swap' ? l.to?.trim() ?? '' : ''
}

/** One styling of the chosen person: an EDIT of their picture, so the face stays theirs (styling test,
 *  2026-10-16: two edits of one plain base kept her face; their stills followed the styling). */
export const styledPersonPrompt = (styling: string): string =>
  `Edit this photo. Change only the styling to: ${styling}. Keep exactly the same face, skin tone, age, body and build, the same plain clothes, pose and background. Real photo, no text.`

export const MAX_STYLINGS = 4
/** The distinct stylings of the person's looks (at most MAX_STYLINGS), with the outfit looks using each. */
export function lookStylings(plan: RemakePlan): Array<{ styling: string; refs: number[] }> {
  const by = new Map<string, number[]>()
  for (const l of plan.looks) {
    if (!personIn(l)) continue
    const s = stylingOf(plan, l)
    if (!s) continue
    const refs = by.get(s) ?? []
    if (!refs.includes(refOf(l))) refs.push(refOf(l))
    by.set(s, refs)
  }
  return [...by.entries()].map(([styling, refs]) => ({ styling, refs })).slice(0, MAX_STYLINGS)
}

/** A look's outfit as the plan has it; '' when none. */
export function outfitOf(plan: RemakePlan, look: RemakeLook): string {
  return shown(plan, `looks[${refOf(look)}].outfit`, look.outfit) ?? ''
}
