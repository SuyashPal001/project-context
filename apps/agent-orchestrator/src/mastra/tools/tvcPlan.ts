import { z } from 'zod'

// The TVC ad's plan and its craft rules, checked in code so a long skill text
// is not the only thing holding them (spec 2026-10-05-tvc-ad-design.md §4-5).
export const WORDS_PER_SECOND = 2.7
export const WORD_CAPS: Record<number, number> = { 6: 8, 15: 22, 20: 30, 30: 45 }
const SHOT_MIN = 1.2, SHOT_MAX = 2.5, PACK_MIN = 2, PACK_MAX = 4
const BRAND_BY = 2.0, PRODUCT_BY = 3.0, VO_TAIL = 2.0, MAX_LINES = 2, MAX_LOCATIONS = 2
const EPS = 0.05

const shotSchema = z.object({
  n: z.number().int().min(1),
  type: z.enum(['hook', 'reaction', 'hero', 'lifestyle', 'reach', 'product_macro', 'mechanism', 'superpower', 'packshot']),
  size: z.enum(['wide', 'medium', 'close_up', 'extreme_close_up']),
  action: z.string().min(1),
  location: z.number().int().min(0).optional(),
  durationSeconds: z.number().positive(),
  brandVisible: z.boolean(),
  productVisible: z.boolean(),
  audio: z.enum(['silent', 'line', 'voiceover']),
  line: z.string().optional(),
  text: z.string().optional(),
  stillFileId: z.string().optional(),
  clipFileId: z.string().optional(),
})

export const tvcPlanSchema = z.object({
  brief: z.object({
    message: z.string().min(1),
    category: z.enum(['beauty', 'personal_care', 'food', 'beverage', 'jewellery', 'fashion', 'home', 'tech', 'other']),
    tier: z.enum(['mass', 'premium', 'luxury']),
    objective: z.enum(['launch', 'brand', 'feature', 'seasonal']),
    market: z.enum(['india', 'generic']),
    lengthSeconds: z.union([z.literal(6), z.literal(15), z.literal(20), z.literal(30)]),
    aspectRatio: z.enum(['16:9', '9:16']),
    productPhotoFileId: z.string().min(1),
    actorAvatarId: z.string().optional(),
  }),
  look: z.string().min(1),
  locations: z.array(z.string().min(1)),
  shots: z.array(shotSchema).min(2),
  voiceover: z.array(z.object({ text: z.string().min(1), startSeconds: z.number().min(0) })),
  packshot: z.object({
    kind: z.enum(['product', 'product_range', 'actor_product_tagline', 'logo_over_scene']),
    tagline: z.string().optional(),
  }),
  legal: z.array(z.object({ text: z.string().min(1), startSeconds: z.number().min(0) })).default([]),
})

export type TvcPlan = z.infer<typeof tvcPlanSchema>
export type TvcShot = TvcPlan['shots'][number]

export const countWords = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length
const r1 = (x: number) => Math.round(x * 10) / 10

export function shotStarts(plan: TvcPlan): number[] {
  const starts: number[] = []
  let t = 0
  for (const s of plan.shots) { starts.push(r1(t)); t += s.durationSeconds }
  return starts
}

export const legalHoldSeconds = (text: string): number => Math.max(4, countWords(text) / 5 + 3)

const VISUALISATION = 'Creative visualisation'

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

  // 2. Durations.
  const total = r1(shots.reduce((sum, s) => sum + s.durationSeconds, 0))
  if (Math.abs(total - length) > EPS) errors.push(`shot durations add up to ${total}s; they must add up to ${length}s`)
  shots.forEach((s) => {
    if (s.type === 'packshot') {
      if (s.durationSeconds < PACK_MIN - EPS || s.durationSeconds > PACK_MAX + EPS) errors.push(`the packshot is ${s.durationSeconds}s; it must be 2–4s`)
    } else if (s.durationSeconds < SHOT_MIN - EPS || s.durationSeconds > SHOT_MAX + EPS) {
      errors.push(`shot ${s.n} is ${s.durationSeconds}s; shots must be 1.2–2.5s`)
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

  // 9. Shot sizes change.
  for (let i = 1; i < shots.length; i++) {
    if (shots[i].size === shots[i - 1].size) errors.push(`shots ${shots[i - 1].n} and ${shots[i].n} are the same size (${shots[i].size}); change one`)
  }

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

  // Warnings and the India market pack.
  if (brief.market === 'india') {
    shots.forEach((s, i) => {
      if ((s.type === 'mechanism' || s.type === 'superpower') && !plan.legal.some((l) => l.text.toLowerCase() === VISUALISATION.toLowerCase())) {
        plan.legal.push({ text: VISUALISATION, startSeconds: starts[i] })
        warnings.push(`added "${VISUALISATION}" from ${starts[i]}s for shot ${s.n}`)
      }
    })
    if (brief.category === 'food' || brief.category === 'beverage') warnings.push('the veg mark is required for food and drink in India but cannot be added yet; tell the user')
  }
  plan.legal.forEach((l) => {
    const hold = legalHoldSeconds(l.text)
    if (l.startSeconds + hold > length + EPS) warnings.push(`the legal line "${l.text}" needs ${hold}s on screen but only has ${r1(length - l.startSeconds)}s`)
  })

  return { errors, warnings, plan }
}

export function sliceTvcPlan(plan: TvcPlan, slice: string): unknown {
  const starts = shotStarts(plan)
  const withStart = (s: TvcShot) => ({ ...s, startSeconds: starts[plan.shots.indexOf(s)] })
  if (slice === 'brief') return { brief: plan.brief, look: plan.look, locations: plan.locations, packshot: plan.packshot }
  if (slice === 'finish') {
    return {
      brief: { lengthSeconds: plan.brief.lengthSeconds, aspectRatio: plan.brief.aspectRatio, productPhotoFileId: plan.brief.productPhotoFileId, market: plan.brief.market, tier: plan.brief.tier, category: plan.brief.category },
      shots: plan.shots.map((s) => ({ n: s.n, type: s.type, startSeconds: starts[s.n - 1], durationSeconds: s.durationSeconds, text: s.text, clipFileId: s.clipFileId })),
      voiceover: plan.voiceover, packshot: plan.packshot, legal: plan.legal,
    }
  }
  const m = /^shots (\d+)-(\d+)$/.exec(slice.trim())
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    return {
      look: plan.look, locations: plan.locations,
      brief: { aspectRatio: plan.brief.aspectRatio, productPhotoFileId: plan.brief.productPhotoFileId, actorAvatarId: plan.brief.actorAvatarId },
      shots: plan.shots.filter((s) => s.n >= a && s.n <= b).map(withStart),
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
  steps.push({ kind: 'music', count: 1 }, { kind: 'edit', count: n + 5 })
  return steps
}
