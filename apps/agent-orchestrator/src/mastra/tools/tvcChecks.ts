import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { persistCost } from '../cost.js'

// Narrow, high-resolution checks for the TVC ad (spec 2026-10-05-tvc-quality-
// tools-design.md §2 "Check design"). One short question per full-resolution
// frame on gemini-2.5-pro. A broad checker (small frames, many questions at
// once) passed a clip whose cap stayed on and missed a cloned face; the narrow
// questions caught both. Free to the user; tokens are logged with persistCost.
const execFile = promisify(execFileCb)
const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
// F5: configurable so a pinned check model can be swapped (e.g. a newer
// Pro release) without a code change; falls back to the model this plan
// verified the checks against.
export const PRO_CHECK_MODEL = process.env.TVC_CHECK_MODEL ?? 'gemini-2.5-pro'
const ASK_TIMEOUT_MS = 120_000
const r2 = (x: number) => Math.round(x * 100) / 100

export interface Img { data: string; mime: string }
export type AskPart = { text: string } | { image: Img }
export type AskFn = (parts: AskPart[]) => Promise<Record<string, unknown>>
export type ProductScale = 'close' | 'medium' | 'wide'
export interface Box { x0: number; y0: number; x1: number; y1: number }

export class CheckUnavailableError extends Error {}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try {
    const v = JSON.parse(raw.slice(s, e + 1)) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** The gateway's chat endpoint on the Pro check model. Retries once; then
 *  throws CheckUnavailableError — callers report "unchecked", never a pass. */
export function gatewayAsk(tenantId: string, fetchImpl: typeof fetch = fetch): AskFn {
  return async (parts) => {
    const content = parts.map((p) => ('text' in p
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: `data:${p.image.mime};base64,${p.image.data}` } }))
    let lastErr: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
          method: 'POST', signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
          headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
          body: JSON.stringify({ model: PRO_CHECK_MODEL, temperature: 0, max_tokens: 4000, messages: [{ role: 'user', content }] }),
        })
        if (!res.ok) throw new Error(`gateway ${res.status}`)
        const json = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
        if (tenantId && json.usage) {
          persistCost({ tenantId, agentId: 'check-clip', workflowId: 'media-understanding', model: PRO_CHECK_MODEL, inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 })
        }
        const v = parseJsonObject(json.choices?.[0]?.message?.content ?? '')
        if (!v) throw new Error('unreadable verdict')
        return v
      } catch (err) {
        lastErr = err
      }
    }
    throw new CheckUnavailableError(`check unavailable: ${(lastErr as Error)?.message ?? 'unknown'}`)
  }
}

// F4: a check must never pass on a verdict that is missing or mistypes the
// key it reads — gatewayAsk already retries a transport/parse failure once;
// this is the same shape one layer up, for a verdict that parsed as JSON but
// doesn't have the shape the check needs (e.g. {} for a glitch question).
// Treated exactly like an unreadable verdict: retry once, then throw —
// callers (checkClip.ts, checkStill.ts) already report CheckUnavailableError
// as "unchecked", never a pass.
export type ExpectKeys = Array<{ key: string; type: 'boolean' | 'array' }>

function verdictHasExpectedKeys(v: Record<string, unknown>, expectKeys: ExpectKeys): boolean {
  return expectKeys.every(({ key, type }) => (type === 'array' ? Array.isArray(v[key]) : typeof v[key] === 'boolean'))
}

export async function askChecked(ask: AskFn, parts: AskPart[], expectKeys: ExpectKeys): Promise<Record<string, unknown>> {
  let v = await ask(parts)
  if (verdictHasExpectedKeys(v, expectKeys)) return v
  v = await ask(parts)
  if (verdictHasExpectedKeys(v, expectKeys)) return v
  throw new CheckUnavailableError(`check verdict missing expected key(s): ${expectKeys.map((e) => e.key).join(', ')}`)
}

export const evenTimes = (duration: number, count: number): number[] =>
  Array.from({ length: count }, (_, i) => r2((duration * (i + 1)) / (count + 1)))
export const lastTimes = (duration: number): number[] =>
  [r2(duration * 0.75), r2(duration * 0.88), r2(Math.max(0, duration - 0.1))]

let sampleSeq = 0
/** Full-resolution frames (no scaling): small frames hid a still-on cap. */
export async function sampleFrames(clipPath: string, times: number[], workDir: string): Promise<Img[]> {
  const batch = ++sampleSeq
  const out: Img[] = []
  for (const [i, t] of times.entries()) {
    const f = join(workDir, `s${batch}-${i}.jpg`)
    await execFile('ffmpeg', ['-y', '-ss', String(t), '-i', clipPath, '-frames:v', '1', '-q:v', '2', f], { timeout: 30_000 })
    out.push({ data: readFileSync(f).toString('base64'), mime: 'image/jpeg' })
  }
  return out
}

export function productQuestion(scale: ProductScale, expectedState?: string): string {
  const attrs = scale === 'wide'
    ? 'the label colour and the logo text (the product is small in this shot, so do not judge its form or material)'
    : 'the material (real glass vs plastic), the shape and proportions, the cap or closure colour and type, the label colour and the logo text'
  const state = expectedState ? ` In this shot it is expected that: ${expectedState}. That is normal, not a difference.` : ''
  return `Image P is the exact product. Image F is one frame from an ad. Look only at the product.${state} A hand covering part of the label is normal. visible: is the product clearly visible in Image F? same: if visible, does it match Image P in ${attrs}? (same is true if the product does not appear). Reply ONLY JSON {"visible":true|false,"same":true|false,"why":"short"}`
}

const PRODUCT_EXPECT_KEYS: ExpectKeys = [{ key: 'visible', type: 'boolean' }, { key: 'same', type: 'boolean' }]

export async function checkProduct(ask: AskFn, product: Img, frames: Img[], opts: { scale: ProductScale; expectedState?: string; mustBeVisible: boolean }): Promise<{ passed: boolean; reason: string; allVisible: boolean }> {
  const q = productQuestion(opts.scale, opts.expectedState)
  const verdicts = await Promise.all(frames.map((f) => askChecked(ask, [{ text: 'Image P:' }, { image: product }, { text: 'Image F:' }, { image: f }, { text: q }], PRODUCT_EXPECT_KEYS)))
  const fails: string[] = []
  let allVisible = true
  verdicts.forEach((v, i) => {
    const visible = v.visible === true
    if (!visible) allVisible = false
    if (opts.mustBeVisible && !visible) fails.push(`frame ${i + 1}: product not visible`)
    else if (visible && v.same === false) fails.push(`frame ${i + 1}: ${String(v.why ?? 'a different product')}`)
  })
  return { passed: fails.length === 0, allVisible, reason: fails.length ? `Product check failed — ${fails.join('; ')}.` : 'Product matches.' }
}

export const GLITCH_QUESTION = 'Image F is one frame from an ad. Answer each strictly: duplicate_object (an object that should be single appears twice, e.g. two bottles in one hand, two identical machines), stray_face (a face where none belongs, e.g. on a machine, wall or object), invented_text (any text or logo on props other than the real product label), cg_effect (cartoon or CG effects such as smoke puffs, sparkles or glowing outlines), flat_background (a flat graphic background where a real place is expected). Reply ONLY JSON {"duplicate_object":true|false,"stray_face":true|false,"invented_text":true|false,"cg_effect":true|false,"flat_background":true|false,"what":"short"}'
const GLITCH_KEYS = ['duplicate_object', 'stray_face', 'invented_text', 'cg_effect', 'flat_background'] as const
const GLITCH_EXPECT_KEYS: ExpectKeys = GLITCH_KEYS.map((key) => ({ key, type: 'boolean' as const }))

export async function checkGlitches(ask: AskFn, frames: Img[]): Promise<{ passed: boolean; reason: string }> {
  const verdicts = await Promise.all(frames.map((f) => askChecked(ask, [{ image: f }, { text: GLITCH_QUESTION }], GLITCH_EXPECT_KEYS)))
  const fails = verdicts.flatMap((v, i) => {
    const hit = GLITCH_KEYS.filter((k) => v[k] === true)
    return hit.length ? [`frame ${i + 1}: ${hit.join(', ').replace(/_/g, ' ')} (${String(v.what ?? '')})`] : []
  })
  return { passed: fails.length === 0, reason: fails.length ? `Visible glitch — ${fails.join('; ')}.` : 'No glitches.' }
}

export const EXTRAS_QUESTION = 'Image F is one frame from an ad. Besides the main person (if any), are other people visible in the background? Reply ONLY JSON {"extras":true|false}'

export async function checkExtras(ask: AskFn, frames: Img[]): Promise<{ passed: boolean; reason: string }> {
  const verdicts = await Promise.all(frames.map((f) => ask([{ image: f }, { text: EXTRAS_QUESTION }])))
  const empty = verdicts.filter((v) => v.extras !== true).length
  const passed = frames.length === 1 ? empty === 0 : empty < 2
  return { passed, reason: passed ? 'Background people present.' : `The background is empty in ${empty} of ${frames.length} frames; this place needs people in it.` }
}

export const CLONE_QUESTION = 'Image L is the lead actor. Image F is one frame from the ad. Ignore the main person (the lead). List every OTHER person in Image F and, for each, say whether they look like the lead in Image L (similar face, hair, skin tone or outfit). Reply ONLY JSON {"others":[{"where":"short","looks_like_lead":true|false}]}'

const CLONE_EXPECT_KEYS: ExpectKeys = [{ key: 'others', type: 'array' }]

export async function checkLeadClone(ask: AskFn, lead: Img, frames: Img[]): Promise<{ passed: boolean; reason: string }> {
  const verdicts = await Promise.all(frames.map((f) => askChecked(ask, [{ text: 'Image L:' }, { image: lead }, { text: 'Image F:' }, { image: f }, { text: CLONE_QUESTION }], CLONE_EXPECT_KEYS)))
  const clones: string[] = []
  verdicts.forEach((v, i) => {
    const others = Array.isArray(v.others) ? v.others as Array<{ where?: unknown; looks_like_lead?: unknown }> : []
    for (const o of others) if (o.looks_like_lead === true) clones.push(`frame ${i + 1}: ${String(o.where ?? 'background')}`)
  })
  return { passed: clones.length === 0, reason: clones.length ? `LEAD_CLONED: a background person looks like the lead (${clones.join('; ')}).` : 'No lookalikes.' }
}

export const LEAD_FACE_QUESTION = 'Image L is the lead actor. Image F is a still from the ad. Is the lead in Image F with the same face and hair? Reply ONLY JSON {"lead_present":true|false,"same_face":true|false,"why":"short"}'

export async function checkLeadFace(ask: AskFn, lead: Img, frame: Img): Promise<{ passed: boolean; reason: string }> {
  const v = await ask([{ text: 'Image L:' }, { image: lead }, { text: 'Image F:' }, { image: frame }, { text: LEAD_FACE_QUESTION }])
  const passed = v.lead_present === true && v.same_face === true
  return { passed, reason: passed ? 'The lead is the same person.' : `The lead is missing or looks different: ${String(v.why ?? '')}.` }
}

export const actionLocateQuestion = (action: string): string =>
  `The frames above are from one video clip in time order, each labelled with its time. For the expected action "${action}", at which labelled time does the key moment happen? Use null if it never happens. Reply ONLY JSON {"action_time":<seconds>|null}`
export const PHYSICS_QUESTION = 'The frames above are from one video clip in time order. Does anything physically impossible happen — an object leaves but is still there (e.g. a cap flies off while the bottle stays capped), or objects appear or vanish? Reply ONLY JSON {"impossible":true|false,"what":"short"}'
// v5's ending: the spin turned back the other way halfway (user: "spun but in
// between spun back to original… awkward dance"). Asked on the same 8 frames.
export const REVERSAL_QUESTION = 'The frames above are from one video clip in time order. Does any movement reverse or undo itself mid-way — a spin that turns back the other way, a step that rewinds, a gesture played backwards? Reply ONLY JSON {"reversal":true|false,"what":"short"}'
export const endStateQuestion = (endState: string): string =>
  `Is this true in Image F: "${endState}"? Look closely at the relevant object. Reply ONLY JSON {"holds":true|false,"why":"short"}`

export async function checkAction(ask: AskFn, frames: { t: number; img: Img }[], last: Img[], action: string, endState?: string): Promise<{ passed: boolean; actionTime: number | null; endStateTrue: boolean; reversed: boolean; reason: string }> {
  const timeline: AskPart[] = [{ text: 'Frames from one video clip, in time order:' }]
  for (const f of frames) timeline.push({ text: `t=${f.t}s` }, { image: f.img })
  const [loc, phys, rev] = await Promise.all([
    ask([...timeline, { text: actionLocateQuestion(action) }]),
    askChecked(ask, [...timeline, { text: PHYSICS_QUESTION }], [{ key: 'impossible', type: 'boolean' }]),
    askChecked(ask, [...timeline, { text: REVERSAL_QUESTION }], [{ key: 'reversal', type: 'boolean' }]),
  ])
  const actionTime = typeof loc.action_time === 'number' ? loc.action_time : null
  const endFails: string[] = []
  if (endState) {
    const verdicts = await Promise.all(last.map((f) => ask([{ text: 'Image F:' }, { image: f }, { text: endStateQuestion(endState) }])))
    verdicts.forEach((v, i) => { if (v.holds !== true) endFails.push(`frame ${i + 1}: ${String(v.why ?? 'not true')}`) })
  }
  const endStateTrue = endFails.length === 0
  const reasons: string[] = []
  if (actionTime === null) reasons.push(`The action never happens: "${action}".`)
  if (!endStateTrue) reasons.push(`ACTION_NOT_COMPLETED: "${endState}" is not true at the end (${endFails.join('; ')}).`)
  if (phys.impossible === true) reasons.push(`Something impossible happens: ${String(phys.what ?? '')}.`)
  const reversed = rev.reversal === true
  if (reversed) reasons.push(`Movement reverses mid-way: ${String(rev.what ?? '')}.`)
  return { passed: reasons.length === 0, actionTime, endStateTrue, reversed, reason: reasons.join(' ') || 'The action happens and its end state holds.' }
}

/** C8: centre the shot's window on the action; no action found → the old 0.4s start. */
export function trimStartFor(actionTime: number | null, durationSeconds: number, clipLength: number): number {
  const latest = Math.max(0, clipLength - durationSeconds)
  if (actionTime === null) return r2(Math.min(0.4, latest))
  return r2(Math.min(latest, Math.max(0, actionTime - 0.4 * durationSeconds)))
}

export interface NarrowClipInputs {
  duration: number
  product?: Img
  productScale?: ProductScale
  productExpectedState?: string
  productMustBeVisible?: boolean
  expectExtras?: boolean
  lead?: Img
  action?: string
  endState?: string
  shotDurationSeconds?: number
}
export interface NarrowClipResult {
  passed: boolean
  reasons: string[]
  glitchFree: boolean
  productVisible?: boolean
  extrasPresent?: boolean
  leadClone?: boolean
  actionHappened?: boolean
  motionReversed?: boolean
  actionTime?: number | null
  endStateTrue?: boolean
  trimStartSeconds?: number
}

export async function runNarrowClipChecks(ask: AskFn, sample: (times: number[]) => Promise<Img[]>, input: NarrowClipInputs): Promise<NarrowClipResult> {
  const reasons: string[] = []
  const out: NarrowClipResult = { passed: true, reasons, glitchFree: true }
  const three = await sample(evenTimes(input.duration, 3))
  const g = await checkGlitches(ask, three)
  out.glitchFree = g.passed
  if (!g.passed) reasons.push(g.reason)
  if (input.product && (input.productScale || input.productMustBeVisible)) {
    const five = await sample(evenTimes(input.duration, 5))
    const p = await checkProduct(ask, input.product, five, { scale: input.productScale ?? 'medium', expectedState: input.productExpectedState, mustBeVisible: !!input.productMustBeVisible })
    out.productVisible = p.allVisible
    if (!p.passed) reasons.push(p.reason)
  }
  if (input.expectExtras) {
    const e = await checkExtras(ask, three)
    out.extrasPresent = e.passed
    if (!e.passed) reasons.push(e.reason)
  }
  if (input.lead) {
    const c = await checkLeadClone(ask, input.lead, three)
    out.leadClone = !c.passed
    if (!c.passed) reasons.push(c.reason)
  }
  if (input.action) {
    const times = evenTimes(input.duration, 8)
    const eight = await sample(times)
    const last = input.endState ? await sample(lastTimes(input.duration)) : []
    const a = await checkAction(ask, times.map((t, i) => ({ t, img: eight[i] })), last, input.action, input.endState)
    out.actionHappened = a.actionTime !== null
    out.motionReversed = a.reversed
    out.actionTime = a.actionTime
    if (input.endState) out.endStateTrue = a.endStateTrue
    if (!a.passed) reasons.push(a.reason)
    if (input.shotDurationSeconds) out.trimStartSeconds = trimStartFor(a.actionTime, input.shotDurationSeconds, input.duration)
  }
  out.passed = reasons.length === 0
  return out
}

export interface StillInputs {
  product?: Img
  productScale?: ProductScale
  productMustBeVisible?: boolean
  expectExtras?: boolean
  lead?: Img
  leadInShot?: boolean
}

export async function runStillChecks(ask: AskFn, still: Img, input: StillInputs): Promise<{ passed: boolean; reasons: string[] }> {
  const reasons: string[] = []
  const g = await checkGlitches(ask, [still])
  if (!g.passed) reasons.push(g.reason)
  if (input.product) {
    const p = await checkProduct(ask, input.product, [still], { scale: input.productScale ?? 'medium', mustBeVisible: !!input.productMustBeVisible })
    if (!p.passed) reasons.push(p.reason)
  }
  if (input.expectExtras) {
    const e = await checkExtras(ask, [still])
    if (!e.passed) reasons.push(e.reason)
  }
  if (input.lead) {
    if (input.leadInShot) {
      const f = await checkLeadFace(ask, input.lead, still)
      if (!f.passed) reasons.push(f.reason)
    }
    const c = await checkLeadClone(ask, input.lead, [still])
    if (!c.passed) reasons.push(c.reason)
  }
  return { passed: reasons.length === 0, reasons }
}

export const FACE_BOX_QUESTION = 'Find every human face in this image. Reply ONLY JSON {"faces":[{"x0":0,"y0":0,"x1":0,"y1":0}]} with coordinates as fractions (0 to 1) of the image width and height; {"faces":[]} if there are none.'

export async function faceBoxes(ask: AskFn, frame: Img): Promise<Box[]> {
  const v = await ask([{ image: frame }, { text: FACE_BOX_QUESTION }])
  const faces = Array.isArray(v.faces) ? v.faces as Array<Record<string, unknown>> : []
  return faces.filter((f) => ['x0', 'y0', 'x1', 'y1'].every((k) => typeof f[k] === 'number'))
    .map((f) => ({ x0: f.x0 as number, y0: f.y0 as number, x1: f.x1 as number, y1: f.y1 as number }))
}

// Vertical bands the overlay_text positions occupy (fractions of height).
export const TEXT_BANDS: Record<'top' | 'center' | 'bottom', [number, number]> = { top: [0, 0.25], center: [0.38, 0.62], bottom: [0.75, 1] }

export function chooseTextPosition(faces: Box[], preferred: 'top' | 'center' | 'bottom'): { position: 'top' | 'center' | 'bottom'; shrink: boolean } {
  const hits = (p: 'top' | 'center' | 'bottom') => faces.some((f) => f.y0 < TEXT_BANDS[p][1] && f.y1 > TEXT_BANDS[p][0])
  const order = [preferred, ...(['top', 'center', 'bottom'] as const).filter((p) => p !== preferred)]
  const free = order.find((p) => !hits(p))
  return free ? { position: free, shrink: false } : { position: 'top', shrink: true }
}

export function chooseCardColumn(faces: Box[]): 'center' | 'left' | 'right' {
  const cols: Record<'center' | 'left' | 'right', [number, number]> = { left: [0, 0.33], center: [0.33, 0.67], right: [0.67, 1] }
  const hits = (c: 'center' | 'left' | 'right') => faces.some((f) => f.x0 < cols[c][1] && f.x1 > cols[c][0])
  return (['center', 'right', 'left'] as const).find((c) => !hits(c)) ?? 'center'
}
