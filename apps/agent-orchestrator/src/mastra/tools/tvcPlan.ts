import { z } from 'zod'
import { LEGAL_MAX_LINES, countLegalWords, escapeAssText, firstWords, legalHoldSeconds, legalLineCount, nominalFrame, tooWideWord } from './legalText.js'
import { MOTIONS, priceError, priceSchema, priceTooShort, priceTooShortReason } from './textMotion.js'

// The TVC ad's plan and its craft rules, checked in code so a long skill text
// is not the only thing holding them (spec 2026-10-05-tvc-ad-design.md §4-5).
export const WORDS_PER_SECOND = 2.7
export const WORD_CAPS: Record<number, number> = { 6: 8, 15: 22, 20: 30 }
// assemble_clips joins at most 12 clips, and every shot is one clip.
export const MAX_SHOTS = 12
const SHOT_MIN = 1.2, SHOT_MAX = 2.5, PACK_MIN = 2, PACK_MAX = 4
const BRAND_BY = 2.0, PRODUCT_BY = 3.0, VO_TAIL = 2.0, MAX_LINES = 2, MAX_LOCATIONS = 2
const EPS = 0.05
const JINGLE_GAP = 0.75, JINGLE_OVER_PACK = 2.0, BED_CLEAR = 0.3
const MAX_OVERLAYS = 12
export { legalHoldSeconds }

export const productTypeSchema = z.object({
  material: z.enum(['glass', 'plastic', 'metal', 'paper', 'other']),
  closure: z.string().min(1).describe('e.g. "crown cap", "screw cap", "pump"'),
  openedBy: z.string().min(1).describe('e.g. "bottle opener", "twist", "pull tab"'),
})
export type ProductType = z.infer<typeof productTypeSchema>
// Actions that change an object's state; each needs an endState the clip check verifies.
export const HARD_ACTION_RE = /\b(open|opens|opened|opening|pop|pops|popped|popping|pour|pours|poured|pouring|bite|bites|biting|apply|applies|applying|peel|peels|peeled|peeling|unwrap|unwraps|unwrapped|unwrapping|cut|cuts|cutting)\b/i
const CONCRETE_VERB_RE = /\b(dance|dances|dancing|spin|spins|spinning|twirl|twirls|jump|jumps|laugh|laughs|run|runs|walk|walks|raise|raises|hold|holds|drink|drinks|sip|sips|smile|smiles|wave|waves|turn|turns|clap|claps|hug|hugs|throw|throws|lift|lifts)\b/i
const SIZE_ORDER = ['wide', 'medium', 'close_up', 'extreme_close_up'] as const
// A turn written loosely ("does one twirl") reversed mid-way in v5; a turn
// must say one direction and complete, and C7's reversal question checks it.
export const TURN_RE = /\b(spin|spins|spinning|twirl|twirls|twirling|pirouette|pirouettes|rotate|rotates|rotating|turns? around)\b/i
export const turnIsComplete = (action: string): boolean => /one direction/i.test(action) && /(360|all the way around|full turn)/i.test(action)

const shotSchema = z.object({
  n: z.number().int().min(1).describe('Shot number, 1 to N in order'),
  type: z.enum(['hook', 'reaction', 'hero', 'lifestyle', 'reach', 'product_macro', 'mechanism', 'superpower', 'packshot']).describe('packshot is always last and only once'),
  size: z.enum(['wide', 'medium', 'close_up', 'extreme_close_up']).describe('Never the same size as the shot before'),
  action: z.string().min(1),
  location: z.number().int().min(0).optional().describe('Index into locations'),
  durationSeconds: z.number().positive().describe('1.2–2.5s; the packshot 2–4s; all shots sum exactly to lengthSeconds'),
  brandVisible: z.boolean().describe('A brandVisible shot must start before 2.0s'),
  productVisible: z.boolean().describe('In ads of 15s or less, a productVisible shot must start by 3.0s'),
  audio: z.enum(['silent', 'line', 'voiceover']).describe('line = an on-camera line (medium or close-up, never under voiceover)'),
  line: z.string().optional().describe('Line shots only: at most durationSeconds × 2.7 words'),
  text: z.string().optional().describe('On-screen text, 3 words or fewer'),
  stillFileId: z.string().optional(),
  clipFileId: z.string().optional(),
  endState: z.string().optional().describe('Required when the action changes an object (open, pop, pour, bite, apply, peel, unwrap, cut): what is true after it, e.g. "the bottle has no cap". The clip check verifies it'),
  continuesFrom: z.number().int().min(1).optional().describe('The previous shot\'s number when this shot continues the same action at the same place; its start frame is that clip\'s last frame, and it is trimmed from 0'),
  angle: z.enum(['eye', 'low', 'high', 'top', 'side', 'pov']).optional().describe('Camera angle. The same angle with the same or a neighbouring size as the shot before is a jump cut'),
  flashCut: z.boolean().optional().describe('A deliberate flash cut, allowed down to 0.3s'),
  motion: z.enum(MOTIONS).optional().describe('How this shot\'s text comes in; plan_tvc sets pop for a shot with text when it is missing'),
  price: priceSchema.optional().describe('A price or offer shown on this shot, e.g. {amount: "₹499", mrp: "₹699", note: "Launch offer"}; never also in text. The shot must be at least 1.2s'),
})

// A sung sign-off over the packshot (spec 2026-10-05-tvc-jingle-design.md J5).
export const jingleSchema = z.object({
  line: z.string().min(1).describe('The sung sign-off, e.g. "Bubbli, feel the magic"'),
  style: z.string().min(1).describe('Genre, mood and voice, e.g. "bright pop, female vocal, 120 bpm"'),
  lyrics: z.array(z.string().min(1)).max(4).optional().describe('Lines sung before the sign-off'),
  language: z.string().optional().describe('The language it is sung in, when not English'),
})

export const legalLineSchema = z.object({
  text: z.string().min(1).describe('The disclaimer, exactly as it should read'),
  forVoiceoverBlock: z.number().int().min(1).optional().describe('The voiceover block that makes the claim (1 = the first block). plan_tvc sets the start to that block\'s start'),
  startSeconds: z.number().min(0).optional().describe('Only for a claim made on screen with no voiceover block: when the disclaimer appears'),
  wholeAd: z.boolean().optional().describe('Keep it on screen for the whole ad, from 0 to the end'),
  linkedWith: z.string().optional().describe('Rare: the same label on disclaimers of one interlinked claim; only those may share the screen'),
  endSeconds: z.number().min(0).optional().describe('Set by plan_tvc check from the ASCI hold rule; never write it'),
  auto: z.boolean().optional().describe('Set by plan_tvc for the "Creative visualisation" line it adds automatically (E9); never set this yourself. May share the screen with a claim\'s own disclaimer without being linked to it'),
})

export const tvcPlanSchema = z.object({
  brief: z.object({
    message: z.string().min(1).describe('The one message: one sentence of 12 words or fewer'),
    category: z.enum(['beauty', 'personal_care', 'food', 'beverage', 'jewellery', 'fashion', 'home', 'tech', 'other']),
    tier: z.enum(['mass', 'premium', 'luxury']),
    objective: z.enum(['launch', 'brand', 'feature', 'seasonal']),
    market: z.enum(['india', 'generic']),
    // A plain number, not z.union of literals: Gemini's function declarations
    // only accept STRING enums, and a numeric enum 400s every Director call.
    lengthSeconds: z.number().refine((n) => n === 6 || n === 15 || n === 20, { message: 'lengthSeconds must be 6, 15 or 20' }).describe('6, 15 or 20 seconds; word cap across voiceover and lines: 6s 8, 15s 22, 20s 30'),
    aspectRatio: z.enum(['16:9', '9:16']),
    productPhotoFileId: z.string().min(1),
    actorAvatarId: z.string().optional(),
    voiceId: z.string().optional().describe('The announcer voice for the voiceover, as Olmo passed it ("Voice ID: <id>")'),
    reference: z.object({
      productType: productTypeSchema.optional(),
      videoFileId: z.string().optional().describe('The reference video. plan_tvc check reads its real cut times from this file and overwrites cutTimes; do not set cutTimes without it'),
      cutTimes: z.array(z.number().positive()).optional().describe('Read-only from plan_tvc\'s point of view: overwritten on every check from the reference video (videoFileId), never from what is sent here'),
    }).optional().describe('When recreating a reference ad: its product type, the reference video (videoFileId), and its real cut times (read from the file by plan_tvc check)'),
    product: productTypeSchema.optional().describe('This product\'s type; must match the reference\'s when one is given'),
    actorLook: z.string().optional().describe('The lead\'s look, e.g. "long dark wavy hair, magenta shirt"; extras never share it'),
    brandName: z.string().optional().describe('The brand name as it appears on screen; not counted in a disclaimer\'s hold time'),
    jingle: jingleSchema.optional().describe('A sung sign-off over the ending; only when the user wants one or the reference ad has one'),
    logoFileId: z.string().optional().describe('The brand logo the user uploaded (PNG or JPG), laid on the packshot; never the product photo'),
    vegMark: z.enum(['veg', 'non_veg']).optional().describe('Food and drink: the veg or non-veg mark on the packshot'),
  }),
  look: z.string().min(1),
  locations: z.array(z.union([z.string().min(1), z.object({
    name: z.string().min(1),
    extras: z.string().optional().describe('Who is in the background, e.g. "students walking past and chatting"; required for public places'),
  })])),
  shots: z.array(shotSchema).min(2).describe(`At most ${MAX_SHOTS} shots`),
  voiceover: z.array(z.object({ text: z.string().min(1), startSeconds: z.number().min(0) })).describe('Announcer blocks; may be empty (a mood ad). Blocks never overlap, never play over a line shot, and end 2s before the end and by the packshot start'),
  packshot: z.object({
    kind: z.enum(['product', 'product_range', 'actor_product_tagline', 'logo_over_scene']),
    tagline: z.string().optional(),
    motion: z.enum(MOTIONS).optional().describe('How the tagline comes in; plan_tvc sets fade when missing'),
  }),
  legal: z.array(legalLineSchema).default([]),
  // Saved by plan_tvc record during the finish, so a second finish reuses
  // them instead of paying for the narration and the song again.
  narrationFileIds: z.array(z.string()).optional().describe('Set by plan_tvc record: one narration per voiceover block, in order'),
  songFileId: z.string().optional().describe('Set by plan_tvc record: the music bed'),
  jingleFileId: z.string().optional().describe('Set by plan_tvc record: the full sung clip from generate_jingle'),
  signoffFileId: z.string().optional().describe('Set by plan_tvc record: the sign-off cut from generate_jingle'),
  signoffSeconds: z.number().positive().optional().describe('Set by plan_tvc record: the sign-off cut\'s length'),
})

export type TvcPlan = z.infer<typeof tvcPlanSchema>
export type TvcShot = TvcPlan['shots'][number]

type Loc = TvcPlan['locations'][number]
export const locationName = (loc: Loc): string => (typeof loc === 'string' ? loc : loc.name)
export const locationExtras = (loc: Loc): string | undefined => (typeof loc === 'string' ? undefined : loc.extras)
const PUBLIC_PLACE_RE = /\b(school|hallway|street|office|market|cafe|café|station|mall|park|restaurant|gym|campus|metro|bus)\b/i

export function varietySentence(actorLook?: string): string {
  return `The background people look clearly different from the lead: mixed hairstyles (short, curly, ponytails, buns), mixed clothing colours and builds${actorLook ? `, and none of them has the lead's look (${actorLook})` : ''}.`
}

// P4: camera grammar by shot type, composed in code rather than left to prose.
export const CAMERA_GRAMMAR: Record<TvcShot['type'], string> = {
  hook: 'An arresting first frame on a real lens, the brand visible.',
  reaction: 'Close on the face, shallow depth of field, a real moment of feeling.',
  hero: 'A composed shot on a real lens, the product held clearly, natural light.',
  lifestyle: 'A real place on a real lens, natural movement, depth in the background.',
  reach: 'A hand moving toward the product, cut before contact, shallow depth of field.',
  product_macro: 'Real lens, shallow depth of field, a slow rack focus, real surfaces and reflections; never a flat graphic background.',
  mechanism: 'A stylised but physical picture of how it works, with real materials.',
  superpower: "The product's feeling as a physical, filmable effect in a real place, no people.",
  packshot: 'The product as hero on a clean real set, with room for the end card, no text.',
}

export function shotPromptFor(plan: TvcPlan, n: number): string {
  const shot = plan.shots.find((s) => s.n === n)
  if (!shot) throw new Error('NO_SUCH_SHOT')
  const loc = shot.location !== undefined ? plan.locations[shot.location] : undefined
  const parts = [`${shot.action.replace(/\.+$/, '')}.`]
  if (TURN_RE.test(shot.action)) parts.push('Every movement goes one way only and completes; nothing reverses, rewinds or plays backwards.')
  if (loc) parts.push(`Place: ${locationName(loc)}.`)
  const extras = loc ? locationExtras(loc) : undefined
  if (extras) {
    parts.push(`Background: ${extras}.`)
    if (plan.brief.actorAvatarId) parts.push(varietySentence(plan.brief.actorLook))
  }
  parts.push(CAMERA_GRAMMAR[shot.type], `Look: ${plan.look}.`, 'No CG effects, no added text.')
  return parts.join(' ')
}

export const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length
const r1 = (x: number) => Math.round(x * 10) / 10
const r2 = (x: number) => Math.round(x * 100) / 100

export function shotStarts(plan: TvcPlan): number[] {
  const starts: number[] = []
  let t = 0
  for (const s of plan.shots) { starts.push(r1(t)); t += s.durationSeconds }
  return starts
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
export function minShotSeconds(plan: TvcPlan, shot: TvcShot): number {
  if (shot.flashCut) return 0.3
  return plan.brief.reference?.cutTimes?.length ? 0.6 : SHOT_MIN
}
/** P1: the 0.4s warm-up plus a margin, or the line's length; a continuing shot is trimmed from 0. */
export function generateSecondsFor(shot: TvcShot): number {
  const base = shot.continuesFrom ? Math.ceil(shot.durationSeconds + 0.3) : Math.ceil(shot.durationSeconds + 0.4 + 0.3)
  const line = shot.audio === 'line' && shot.line ? Math.ceil(countWords(shot.line) / WORDS_PER_SECOND + 1) : 0
  return clamp(Math.max(base, line), 3, 10)
}

const VISUALISATION = 'Creative visualisation'

export interface LegalTiming { text: string; startSeconds: number; endSeconds: number; lines: number }

/** L2/L3: every disclaimer's start and hold, computed (never chosen by Director).
 *  `autoAddedIndex`, when given, names the one `plan.legal` entry this same
 *  check call auto-added for a mechanism/superpower shot (E9): only that
 *  entry gets the "added automatically" wording, never a Director-written
 *  line that merely has the same text. */
export function legalTimings(plan: TvcPlan, opts: { autoAddedIndex?: number } = {}): { timings: Array<LegalTiming | null>; errors: string[] } {
  const errors: string[] = []
  const length = plan.brief.lengthSeconds
  const frame = nominalFrame(plan.brief.aspectRatio)
  const brandName = plan.brief.brandName
  const starts = shotStarts(plan)
  // Other words on screen while [a, b) is showing: shot texts, a shot's price
  // (amount, MRP and note), and the packshot tagline.
  const priceWords = (p?: { amount: string; mrp?: string; note?: string }): number =>
    p ? countLegalWords(p.amount, brandName) + (p.mrp ? countLegalWords(p.mrp, brandName) : 0) + (p.note ? countLegalWords(p.note, brandName) : 0) : 0
  const otherWords = (a: number, b: number): number => plan.shots.reduce((n, s, i) => {
    if (!(starts[i] < b - EPS && starts[i] + s.durationSeconds > a + EPS)) return n
    const shotText = s.text ? countLegalWords(s.text, brandName) : 0
    const tagline = s.type === 'packshot' && plan.packshot.tagline ? countLegalWords(plan.packshot.tagline, brandName) : 0
    return n + shotText + tagline + priceWords(s.price)
  }, 0)
  if (plan.legal.length > MAX_OVERLAYS) errors.push(`LEGAL_TOO_MANY: there are ${plan.legal.length} legal lines; overlay_text takes at most ${MAX_OVERLAYS} overlays`)
  const timings = plan.legal.map((l, i): LegalTiming | null => {
    // Measure exactly what overlay_text will render — escapeAssText strips
    // `{`, `}` and `\`, so a word only too wide once those are gone (or
    // only short enough with them in) must not disagree between the two.
    const measured = escapeAssText(l.text)
    const wide = tooWideWord(measured, frame)
    if (wide) {
      errors.push(`LEGAL_TOO_LONG: the disclaimer "${firstWords(l.text)}" has a word too wide for one line ("${wide}"); shorten it or write the URL shorter`)
      return null
    }
    const lines = legalLineCount(measured, frame)
    if (lines > LEGAL_MAX_LINES) {
      errors.push(`LEGAL_TOO_LONG: the disclaimer "${firstWords(l.text)}" needs ${lines} lines; ASCI allows 2. Shorten it`)
      return null
    }
    if (l.wholeAd) return { text: l.text, startSeconds: 0, endSeconds: length, lines }
    let start: number
    if (l.forVoiceoverBlock !== undefined) {
      const block = plan.voiceover[l.forVoiceoverBlock - 1]
      if (!block) {
        errors.push(`LEGAL_CLAIM_MISSING: legal line "${l.text}" points at voiceover block ${l.forVoiceoverBlock}, which doesn't exist`)
        return null
      }
      start = block.startSeconds
    } else if (l.startSeconds !== undefined) {
      start = l.startSeconds
    } else {
      errors.push(`LEGAL_START_MISSING: legal line "${l.text}" needs forVoiceoverBlock (the voiceover block that makes the claim), startSeconds (an on-screen-only claim) or wholeAd`)
      return null
    }
    // The hold counts the words on screen during it, and the window depends on
    // the hold: grow both until they agree (monotone, so this settles).
    let others = 0
    let hold = legalHoldSeconds(l.text, 0, { lines, brandName })
    for (let k = 0; k < 50; k++) {
      const next = otherWords(start, start + hold)
      if (next === others) break
      others = next
      hold = legalHoldSeconds(l.text, others, { lines, brandName })
    }
    const end = r2(start + hold)
    if (end > length + EPS) {
      if (i === opts.autoAddedIndex) {
        // F6: no instruction to edit the auto line itself. When a claim
        // exists, the fix is on its disclaimer or its voiceover; with no
        // claim at all, the only levers left are the voiceover and the shot.
        const hasClaim = plan.legal.some((pl, idx) => idx !== i && !pl.auto)
        errors.push(hasClaim
          ? `LEGAL_HOLD_TOO_LONG: "${l.text}" was added automatically for a mechanism or superpower shot and needs ${hold}s on screen, which does not fit; add wholeAd: true to the claim's disclaimer, or shorten the voiceover`
          : `LEGAL_HOLD_TOO_LONG: "${l.text}" was added automatically for a mechanism or superpower shot and needs ${hold}s on screen, which does not fit; shorten the voiceover, or move the mechanism or superpower shot earlier`)
      } else {
        errors.push(`LEGAL_HOLD_TOO_LONG: "${l.text}" needs ${hold}s on screen; start it earlier, shorten it, or keep it on for the whole ad`)
      }
    }
    return { text: l.text, startSeconds: start, endSeconds: end, lines }
  })
  // L3/E6: one disclaimer on screen at a time, unless linked to the same claim.
  const placed = timings.flatMap((t, i) => (t ? [{ ...t, i }] : [])).sort((a, b) => a.startSeconds - b.startSeconds)
  for (let x = 0; x < placed.length; x++) {
    for (let y = x + 1; y < placed.length; y++) {
      const a = placed[x], b = placed[y]
      if (!(b.startSeconds < a.endSeconds - EPS && a.startSeconds < b.endSeconds - EPS)) continue
      const la = plan.legal[a.i], lb = plan.legal[b.i]
      if (la.linkedWith && la.linkedWith === lb.linkedWith) continue
      // F6 (corrected): the auto-added "Creative visualisation" line may
      // share the screen with a claim's own disclaimer — only when exactly
      // one side is the auto line. Two claims (neither auto) still conflict
      // as before, and two auto lines colliding with each other still do too.
      if (!!la.auto !== !!lb.auto) continue
      // F5: two disclaimers each synced to their own voiceover block need a
      // scheduling fix (move the later block), not a merge-or-overlap hint.
      if (la.forVoiceoverBlock !== undefined && lb.forVoiceoverBlock !== undefined && la.forVoiceoverBlock !== lb.forVoiceoverBlock) {
        errors.push(`LEGAL_OVERLAP: "${firstWords(a.text)}" and "${firstWords(b.text)}" would be on screen together; combine them into one disclaimer, or start voiceover block ${lb.forVoiceoverBlock} at or after ${a.endSeconds}s`)
        continue
      }
      let fix = '; start the second after the first ends'
      if (la.forVoiceoverBlock !== undefined && la.forVoiceoverBlock === lb.forVoiceoverBlock) {
        fix = `; both explain voiceover block ${la.forVoiceoverBlock}: combine them into one disclaimer (at most 2 lines) or move the second claim to its own voiceover block`
      } else if (a.i === opts.autoAddedIndex || b.i === opts.autoAddedIndex) {
        // F6: Director cannot edit the auto-added line itself; the fix is on
        // the claim it collided with, or the voiceover that moved into it.
        fix = `; the plan could not fit "${VISUALISATION}" automatically: add wholeAd: true to the claim's disclaimer, or shorten the voiceover`
      }
      errors.push(`LEGAL_OVERLAP: only one disclaimer on screen at a time ("${firstWords(a.text)}" ${a.startSeconds}–${a.endSeconds}s and "${firstWords(b.text)}" from ${b.startSeconds}s)${fix}`)
    }
  }
  return { timings, errors }
}

/** E4: the end card is laid first and the text last — after every mix step,
 *  not just voiceover — so a disclaimer is always the top layer and nothing
 *  after overlay_text can remove its marker. */
export function finishOrder(plan: TvcPlan): string[] {
  const order = ['composite_end_card', 'assemble_clips']
  if (plan.voiceover.length > 0 || plan.brief.jingle) order.push('mix_voiceover')
  order.push('mix_music_bed', 'overlay_text')
  return order
}

export function validateTvcPlan(input: TvcPlan): { errors: string[]; warnings: string[]; plan: TvcPlan } {
  const plan: TvcPlan = structuredClone(input)
  const errors: string[] = []
  const warnings: string[] = []
  const { brief, shots } = plan
  const length = brief.lengthSeconds
  const starts = shotStarts(plan)

  // Shot numbering — record() addresses shots by n.
  if (shots.some((s, i) => s.n !== i + 1)) errors.push(`shots must be numbered 1 to ${shots.length} in order`)

  // 1. One message.
  const inner = brief.message.trim().replace(/[.!?]+$/, '')
  if (/[.!?](\s|$)/.test(inner)) errors.push('the message must be one sentence')
  if (countWords(brief.message) > 12) errors.push(`the message is ${countWords(brief.message)} words; keep it to 12 words or fewer`)

  // assemble_clips joins at most 12 clips.
  if (shots.length > MAX_SHOTS) errors.push(`there are ${shots.length} shots; at most ${MAX_SHOTS}`)

  // 2. Durations.
  const total = r1(shots.reduce((sum, s) => sum + s.durationSeconds, 0))
  if (Math.abs(total - length) > EPS) errors.push(`shot durations add up to ${total}s; they must add up to ${length}s`)
  shots.forEach((s) => {
    if (s.type === 'packshot') {
      if (s.durationSeconds < PACK_MIN - EPS || s.durationSeconds > PACK_MAX + EPS) errors.push(`the packshot is ${s.durationSeconds}s; it must be 2–4s`)
    } else if (s.durationSeconds < minShotSeconds(plan, s) - EPS || s.durationSeconds > SHOT_MAX + EPS) {
      errors.push(`shot ${s.n} is ${s.durationSeconds}s; shots must be ${minShotSeconds(plan, s)}–2.5s`)
    }
  })

  // 3. Brand early. 4. Product early.
  if (!shots.some((s, i) => s.brandVisible && starts[i] < BRAND_BY)) errors.push('the brand must be on screen before 2.0s (a brandVisible shot starting before 2.0s)')
  if (length <= 15 && !shots.some((s, i) => s.productVisible && starts[i] <= PRODUCT_BY + EPS)) errors.push('the product must appear by 3.0s')

  // 5. Word caps.
  const lineShots = shots.filter((s) => s.audio === 'line')
  const words = plan.voiceover.reduce((n, v) => n + countWords(v.text), 0) + lineShots.reduce((n, s) => n + countWords(s.line ?? ''), 0)
  const cap = WORD_CAPS[length]
  if (words > cap) errors.push(`the script is ${words} words; cap ${cap} for ${length}s`)

  // 6. Voiceover ends early.
  const voEnds = plan.voiceover.map((v) => r1(v.startSeconds + countWords(v.text) / WORDS_PER_SECOND))
  const lastVo = Math.max(0, ...voEnds)
  if (lastVo > length - VO_TAIL + EPS) errors.push(`the voiceover ends at ${lastVo}s; it must end by ${length - VO_TAIL}s`)
  // The packshot's moment belongs to the end card and its tagline (spec §1).
  const packIdx = shots.findIndex((s) => s.type === 'packshot')
  if (packIdx >= 0 && lastVo > starts[packIdx] + EPS) errors.push(`the voiceover ends at ${lastVo}s; it must end by the packshot's start (${starts[packIdx]}s)`)
  // F1: a jingle's sung sign-off must be known to fit before any money is
  // spent on it — estimated here from the line's word count, not measured.
  if (brief.jingle) {
    const packSeconds = packIdx >= 0 ? shots[packIdx].durationSeconds : 0
    const estimate = estimateSignoffSeconds(brief.jingle.line, packSeconds)
    const speechEnd = lastSpeechEnd(plan)
    const deadline = r1(length - estimate - 0.75)
    // No + EPS slack here: jingleErrors (the record-time check, run against the
    // measured signoff) uses `gap < JINGLE_GAP` with no slack either. A plan that
    // passes this estimate-time check must not then fail record on the same number.
    if (speechEnd > length - estimate - 0.75) {
      errors.push(`JINGLE_WONT_FIT: the sung line needs about ${r1(estimate)}s at the end, but speech runs until ${r1(speechEnd)}s; end the voiceover by ${deadline}s or shorten the line`)
    }
  }
  // Blocks never talk over each other.
  const byStart = plan.voiceover.map((v, i) => ({ i, start: v.startSeconds, end: voEnds[i] })).sort((a, b) => a.start - b.start)
  for (let k = 1; k < byStart.length; k++) {
    if (byStart[k].start < byStart[k - 1].end - EPS) errors.push(`voiceover blocks ${byStart[k - 1].i + 1} and ${byStart[k].i + 1} overlap; start block ${byStart[k].i + 1} at ${byStart[k - 1].end}s or later`)
  }

  // 7. Lines.
  if (lineShots.length > MAX_LINES) errors.push(`there are ${lineShots.length} on-camera lines; at most ${MAX_LINES}`)
  shots.forEach((s) => {
    if (s.audio === 'line') {
      if (!s.line?.trim()) { errors.push(`shot ${s.n} has audio "line" but no line`); return }
      if (s.size !== 'medium' && s.size !== 'close_up') errors.push(`the line in shot ${s.n} must be in a medium or close-up shot`)
      const fit = Math.floor(s.durationSeconds * WORDS_PER_SECOND)
      if (countWords(s.line) > fit) errors.push(`the line in shot ${s.n} does not fit: ${countWords(s.line)} words in ${s.durationSeconds}s (at most ${fit})`)
    } else if (s.line) {
      errors.push(`shot ${s.n} has a line but its audio is "${s.audio}"`)
    }
  })

  // 8. No voiceover over a line.
  plan.voiceover.forEach((v, vi) => {
    shots.forEach((s, i) => {
      if (s.audio !== 'line') return
      const a = starts[i], b = starts[i] + s.durationSeconds
      if (v.startSeconds < b - EPS && voEnds[vi] > a + EPS) errors.push(`voiceover block ${vi + 1} overlaps the line in shot ${s.n}`)
    })
  })

  // 9. Shot sizes change; the same size needs a different angle; the same
  //    angle with a neighbouring size is a jump cut (v4's two-shot opener).
  for (let i = 1; i < shots.length; i++) {
    const a = shots[i - 1], b = shots[i]
    if (b.continuesFrom) continue
    const sameAngle = !!a.angle && a.angle === b.angle
    if (a.size === b.size && (!a.angle || !b.angle || sameAngle)) {
      errors.push(`shots ${a.n} and ${b.n} are the same size (${b.size}); change one, or give them different angles`)
    } else if (sameAngle && Math.abs(SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size)) === 1) {
      errors.push(`shots ${a.n} and ${b.n} are near-identical framings (same ${b.angle} angle, ${a.size} then ${b.size}): a jump cut. Change the angle, or keep the action in one shot`)
    }
  }
  // P2: continuity only with the shot right before, at the same place.
  shots.forEach((s, i) => {
    if (s.continuesFrom === undefined) return
    if (s.continuesFrom !== s.n - 1) { errors.push(`shot ${s.n} continues from shot ${s.continuesFrom}; it can only continue the shot right before it`); return }
    if (shots[i - 1] && shots[i - 1].location !== s.location) errors.push(`shot ${s.n} continues shot ${s.continuesFrom} but is at a different place`)
    // F1: chains (3 continues 2 continues 1) make the middle shot's trim
    // impossible — it would need to both start at 0 (continuing) and end at
    // the clip's own end (trimToEnd). Continue from one shot only.
    if (shots[i - 1]?.continuesFrom !== undefined) errors.push(`shot ${s.n} continues shot ${s.continuesFrom}, which itself continues shot ${shots[i - 1].continuesFrom}; continue from one shot only, not a chain`)
  })
  // P10: a turn is one direction and complete.
  shots.forEach((s) => {
    if (TURN_RE.test(s.action) && !turnIsComplete(s.action)) errors.push(`shot ${s.n} has a turn ("${s.action}"); write it as one direction and complete, e.g. "spins all the way around in one direction, 360°"`)
  })
  // P7: a state-changing action needs an end state.
  shots.forEach((s) => {
    if (HARD_ACTION_RE.test(s.action) && !s.endState?.trim()) errors.push(`shot ${s.n} changes an object ("${s.action}"); add endState (what is true after it)`)
  })

  // 10. Packshot last, once.
  if (shots[shots.length - 1].type !== 'packshot') errors.push('the last shot must be the packshot')
  if (shots.filter((s) => s.type === 'packshot').length > 1) errors.push('there must be only one packshot')

  // 11. Locations and actor.
  if (plan.locations.length > MAX_LOCATIONS) errors.push(`use at most 2 locations (there are ${plan.locations.length})`)
  shots.forEach((s) => {
    if (s.location !== undefined && s.location >= plan.locations.length) errors.push(`shot ${s.n} uses location ${s.location}, which does not exist`)
  })
  if (!brief.actorAvatarId && lineShots.length > 0) errors.push('an ad with no actor cannot have on-camera lines')

  // 12. Short on-screen text.
  shots.forEach((s) => {
    if (s.text && s.type !== 'packshot' && countWords(s.text) > 3) errors.push(`the text in shot ${s.n} must be 3 words or fewer`)
  })

  // 13. Text motion and prices (spec 2026-10-09 M1, M2, M5, X7). The default
  //     motion is written into the plan here, at check, so a plan saved
  //     before this change (never re-checked) stays static (X12).
  shots.forEach((s) => {
    if (s.text && s.price) errors.push(`PRICE_AND_TEXT: shot ${s.n} has both text and a price; put the price in price only`)
    if (s.text && !s.motion) s.motion = 'pop'
    if (!s.price) return
    const err = priceError(s.price)
    if (err) errors.push(`${err} (shot ${s.n})`)
    // priceTooShort is shared with overlay_text's paid-time check (same
    // epsilon), so a price that passes here never gets refused only after
    // the charge.
    else if (priceTooShort(s.durationSeconds)) errors.push(priceTooShortReason(s.durationSeconds, `the price in shot ${s.n}`))
  })
  if (plan.packshot.tagline && !plan.packshot.motion) plan.packshot.motion = 'fade'

  // P5: a recreation copies the reference's product TYPE; only the brand changes.
  const refType = brief.reference?.productType
  if (refType) {
    const norm = (t: ProductType) => `${t.material}|${t.closure.trim().toLowerCase()}|${t.openedBy.trim().toLowerCase()}`
    const describe = (t: ProductType) => `a ${t.material} ${t.closure.trim().toLowerCase()} product opened with a ${t.openedBy.trim().toLowerCase()}`
    if (!brief.product || norm(brief.product) !== norm(refType)) {
      errors.push(`REFERENCE_PRODUCT_MISMATCH: the reference uses ${describe(refType)}; this product is ${brief.product ? describe(brief.product) : 'not described (set brief.product)'}. Copy the reference's product type and change only the brand`)
    }
  }
  // P6: when recreating, shot boundaries follow the reference's real cuts.
  const refCuts = (brief.reference?.cutTimes ?? []).filter((t) => t < length - EPS).sort((x, y) => x - y)
  if (refCuts.length) {
    const boundaries = starts.slice(1)
    if (boundaries.length !== refCuts.length) {
      errors.push(`the reference has ${refCuts.length} cuts in ${length}s; this plan has ${boundaries.length}`)
    } else {
      boundaries.forEach((b, i) => {
        if (Math.abs(b - refCuts[i]) > 0.15 + EPS) errors.push(`the cut after shot ${i + 1} is at ${b}s; the reference cuts at ${refCuts[i]}s`)
      })
    }
  }

  // Warnings and the India market pack.
  // E9: Director never wrote the auto-added line, so it can't fix a hard
  // failure on it — clamp its start to the latest moment that still fits,
  // and mark it `auto: true` so it may share the screen with a claim's own
  // disclaimer instead of refusing (the overlap check skips a pair only when
  // exactly one side is the auto line; a claim's linkedWith is never
  // touched). Only a line that genuinely cannot fit (clamped or not) still
  // fails, and that failure says so and points at wholeAd.
  let autoAddedIndex: number | undefined
  if (brief.market === 'india') {
    shots.forEach((s, i) => {
      if ((s.type === 'mechanism' || s.type === 'superpower') && !plan.legal.some((l) => l.text.toLowerCase() === VISUALISATION.toLowerCase())) {
        const frame = nominalFrame(brief.aspectRatio)
        const lines = legalLineCount(VISUALISATION, frame)
        const hold = legalHoldSeconds(VISUALISATION, 0, { lines, brandName: brief.brandName })
        const start = clamp(Math.min(starts[i], length - hold), 0, length)
        plan.legal.push({ text: VISUALISATION, startSeconds: start, auto: true })
        autoAddedIndex = plan.legal.length - 1
        warnings.push(`added "${VISUALISATION}" from ${start}s for shot ${s.n}`)
      }
    })
    if ((brief.category === 'food' || brief.category === 'beverage') && !brief.vegMark) warnings.push('the veg mark is recommended for food and drink (an FSSAI packaging rule; common practice in TV ads); set brief.vegMark (veg or non_veg) for food and drink')
  }
  // M2: an MRP next to a lower price is an offer claim; remind, never invent a disclaimer.
  if (shots.some((s) => s.price?.mrp) && !plan.legal.some((l) => !l.auto)) {
    warnings.push('a price with an MRP is an offer claim; ASCI expects a disclaimer for it (for example "Offer valid till stocks last"); ask the user for one')
  }
  plan.locations.forEach((loc) => {
    if (PUBLIC_PLACE_RE.test(locationName(loc)) && !locationExtras(loc)) warnings.push(`"${locationName(loc)}" is a public place; add extras (who is in the background) so it does not look empty`)
  })
  // L2/L3: the hold is an error now, and the plan stores the computed times.
  const legal = legalTimings(plan, { autoAddedIndex })
  errors.push(...legal.errors)
  legal.timings.forEach((t, i) => {
    if (!t) return
    plan.legal[i].startSeconds = t.startSeconds
    plan.legal[i].endSeconds = t.endSeconds
  })

  // P10: the payoff (the shot before the packshot) must be a checkable move.
  const payoff = packIdx > 0 ? shots[packIdx - 1] : undefined
  if (payoff && !CONCRETE_VERB_RE.test(payoff.action)) warnings.push(`shot ${payoff.n} is the payoff; write a concrete, physical move the check can verify (e.g. "she dances and spins all the way around in one direction, 360°"), not only a mood`)

  return { errors, warnings, plan }
}

/** When the last spoken word ends: voiceover blocks and on-camera lines, both at 2.7 words per second. */
export function lastSpeechEnd(plan: TvcPlan): number {
  const starts = shotStarts(plan)
  const vo = plan.voiceover.map((v) => r1(v.startSeconds + countWords(v.text) / WORDS_PER_SECOND))
  const lines = plan.shots.map((s, i) => (s.audio === 'line' && s.line ? r1(starts[i] + countWords(s.line) / WORDS_PER_SECOND) : 0))
  return Math.max(0, ...vo, ...lines)
}

/** F1: estimates the sung sign-off's length from its word count, before it is ever generated or measured. */
export function estimateSignoffSeconds(line: string, packshotSeconds: number): number {
  return Math.min(countWords(line) / 2.0 + 0.6, packshotSeconds + 2)
}

/** The sign-off ends with the ad; it must start 0.75s after the last word and fit the packshot plus 2s. */
export function jingleErrors(plan: TvcPlan, signoffSeconds: number): string[] {
  const errors: string[] = []
  const start = r2(plan.brief.lengthSeconds - signoffSeconds)
  const gap = r2(start - lastSpeechEnd(plan))
  if (gap < JINGLE_GAP) {
    const where = gap >= 0 ? `start ${gap}s after the last word` : `start ${r2(Math.abs(gap))}s before the last word ends`
    errors.push(`JINGLE_OVERLAPS_SPEECH: the sung line would ${where}; shorten the line or end the voiceover earlier`)
  }
  const max = r2(plan.shots[plan.shots.length - 1].durationSeconds + JINGLE_OVER_PACK)
  if (signoffSeconds > max + EPS) errors.push(`JINGLE_TOO_LONG: the sung sign-off is ${signoffSeconds}s; at most ${max}s (the packshot plus 2s); shorten the line`)
  return errors
}

export function signoffTiming(plan: TvcPlan): { signoffStartSeconds: number; musicFadeOutAtSeconds: number } | undefined {
  if (plan.signoffSeconds === undefined) return undefined
  const start = r2(plan.brief.lengthSeconds - plan.signoffSeconds)
  return { signoffStartSeconds: start, musicFadeOutAtSeconds: r2(Math.max(0, start - BED_CLEAR)) }
}

/** M3/M4: what composite_end_card needs. The veg mark is for food and drink
 *  only; disclaimerLines is the most lines of any disclaimer still on screen
 *  during the packshot, so the mark sits above that box. */
export function endCardInputs(plan: TvcPlan): { logoFileId?: string; vegMark?: 'veg' | 'non_veg'; disclaimerLines?: number } | undefined {
  const food = plan.brief.category === 'food' || plan.brief.category === 'beverage'
  const vegMark = food ? plan.brief.vegMark : undefined
  if (!plan.brief.logoFileId && !vegMark) return undefined
  const out: { logoFileId?: string; vegMark?: 'veg' | 'non_veg'; disclaimerLines?: number } = {}
  if (plan.brief.logoFileId) out.logoFileId = plan.brief.logoFileId
  if (vegMark) {
    out.vegMark = vegMark
    const packIdx = plan.shots.findIndex((s) => s.type === 'packshot')
    const packStart = packIdx >= 0 ? shotStarts(plan)[packIdx] : plan.brief.lengthSeconds
    const lines = legalTimings(plan).timings.reduce((n, t) => (t && t.endSeconds > packStart + EPS ? Math.max(n, t.lines) : n), 0)
    if (lines > 0) out.disclaimerLines = Math.min(lines, 2)
  }
  return out
}

export function sliceTvcPlan(plan: TvcPlan, slice: string): unknown {
  const starts = shotStarts(plan)
  const withStart = (s: TvcShot) => ({ ...s, startSeconds: starts[plan.shots.indexOf(s)] })
  if (slice === 'brief') return { brief: plan.brief, look: plan.look, locations: plan.locations, packshot: plan.packshot }
  if (slice === 'finish') {
    const endCard = endCardInputs(plan)
    return {
      brief: { lengthSeconds: plan.brief.lengthSeconds, aspectRatio: plan.brief.aspectRatio, productPhotoFileId: plan.brief.productPhotoFileId, market: plan.brief.market, tier: plan.brief.tier, category: plan.brief.category, voiceId: plan.brief.voiceId },
      shots: plan.shots.map((s) => ({
        n: s.n, type: s.type, startSeconds: starts[s.n - 1], durationSeconds: s.durationSeconds, text: s.text, clipFileId: s.clipFileId,
        ...(s.motion ? { motion: s.motion } : {}),
        ...(s.price ? { price: s.price } : {}),
      })),
      voiceover: plan.voiceover, packshot: plan.packshot,
      legal: legalTimings(plan).timings.flatMap((t) => (t ? [{ text: t.text, startSeconds: t.startSeconds, endSeconds: t.endSeconds, style: 'legal' as const }] : [])),
      narrationFileIds: plan.narrationFileIds, songFileId: plan.songFileId,
      ...(plan.brief.jingle ? { jingle: plan.brief.jingle } : {}),
      ...(plan.signoffSeconds !== undefined
        ? { jingleFileId: plan.jingleFileId, signoffFileId: plan.signoffFileId, signoffSeconds: plan.signoffSeconds, ...signoffTiming(plan) }
        : {}),
      ...(plan.legal.length > 0 ? { finishOrder: finishOrder(plan) } : {}),
      ...(endCard ? { endCard } : {}),
    }
  }
  const m = /^shots (\d+)-(\d+)$/.exec(slice.trim())
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    return {
      look: plan.look, locations: plan.locations,
      brief: { aspectRatio: plan.brief.aspectRatio, productPhotoFileId: plan.brief.productPhotoFileId, actorAvatarId: plan.brief.actorAvatarId },
      shots: plan.shots.filter((s) => s.n >= a && s.n <= b).map((s) => {
        const isContinuing = s.continuesFrom !== undefined
        const trimsToEnd = plan.shots.some((o) => o.continuesFrom === s.n)
        const previousShot = isContinuing ? plan.shots.find((o) => o.n === s.continuesFrom) : undefined
        // F3: the start still is only safe to anchor the product render on when
        // the shot shows the product and is NOT continuing (a continuing shot's
        // start frame must be the literal previous clip's last frame; anchoring
        // would move that still into referenceImageUris instead).
        const productAnchor = s.productVisible && !isContinuing
        return {
          ...withStart(s),
          generateSeconds: generateSecondsFor(s),
          startFromPreviousLastFrame: isContinuing,
          trimStartSeconds: isContinuing ? 0 : 0.4,
          trimToEnd: trimsToEnd,
          // F1: when a slice sets these, its values win over check_clip's
          // trimStartSeconds — a continuing shot must start at 0, and a
          // trimToEnd shot must end at the clip's own end, never a centred trim.
          ...(isContinuing ? { trimFixed: true, previousClipFileId: previousShot?.clipFileId } : {}),
          ...(trimsToEnd ? { trimFixed: true, trimFromEnd: true } : {}),
          productAnchor,
          prompt: shotPromptFor(plan, s.n),
        }
      }),
    }
  }
  throw new Error('UNKNOWN_SLICE')
}

export function recordOnPlan(plan: TvcPlan, n: number, files: { stillFileId?: string; clipFileId?: string }): TvcPlan {
  const next: TvcPlan = structuredClone(plan)
  const shot = next.shots.find((s) => s.n === n)
  if (!shot) throw new Error('NO_SUCH_SHOT')
  if (files.stillFileId) { shot.stillFileId = files.stillFileId; delete shot.clipFileId }
  if (files.clipFileId) shot.clipFileId = files.clipFileId
  return next
}

// Stills + clips per shot; a trim per shot plus the finish's five edits
// (end card, join, voiceover mix, text, music mix); one narration per block.
export function tvcCreditSteps(plan: TvcPlan): Array<{ kind: 'image' | 'video' | 'narration' | 'music' | 'edit'; count: number }> {
  const n = plan.shots.length
  const steps: Array<{ kind: 'image' | 'video' | 'narration' | 'music' | 'edit'; count: number }> = [
    { kind: 'image', count: n }, { kind: 'video', count: n },
  ]
  if (plan.voiceover.length > 0) steps.push({ kind: 'narration', count: plan.voiceover.length })
  steps.push({ kind: 'music', count: 1 })
  // The jingle is priced as a second music step (the lyria-002 rate, 8
  // credits, is above Lyria 3's 4, so the estimate never runs short).
  if (plan.brief.jingle) steps.push({ kind: 'music', count: 1 })
  steps.push({ kind: 'edit', count: n + 5 })
  return steps
}
