import { estimateSignoffSeconds, shotStarts, signoffTiming, type TvcPlan } from './tvcPlan.js'

// Part 2.6 (spec 2026-10-11-tvc-claims-summary-design.md): every risky claim
// in a TVC plan, found in code while planning, so the user answers for it
// before a still is paid for. Never "compliant": a checklist the user signs.

export const CLAIM_KINDS = ['superlative', 'number', 'proven', 'endorsement', 'absolute', 'health', 'offer', 'visual'] as const
export type ClaimKind = typeof CLAIM_KINDS[number]
export type ClaimPlace = 'voiceover' | 'line' | 'shot_text' | 'price_note' | 'tagline' | 'jingle' | 'offer' | 'visual'
export interface Where { place: ClaimPlace; ref?: number; startSeconds: number }
export interface Finding { text: string; key: string; kind: ClaimKind; where: Where[]; likelyBanned?: true; informational?: true }

export const CLAIM_STATUSES = ['proof', 'no_proof', 'not_a_claim'] as const
export type ClaimStatus = typeof CLAIM_STATUSES[number]
export interface ClaimEntry { text: string; status: ClaimStatus; proof?: string }

/** The request-context key hooks.ts sets from Olmo's "Claims:" lines (D9). */
export const TVC_CLAIM_ANSWERS_KEY = 'tvcClaimAnswers'

const prepare = (text: string) => text.normalize('NFC').replace(/[‌‍]/g, '')

/** One claim, one key, however Director or the user typed it (I3). */
export function claimKey(text: string): string {
  return prepare(text).toLowerCase()
    .replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"')
    .replace(/\s+/g, ' ').trim()
    .replace(/^['"\s]+/u, '').replace(/[.,;:!?।'"\s]+$/u, '')
}

// JS \b is ASCII-only even with the u flag: it never matches around "#1",
// "100%" or a Devanagari word (C4). Every pattern gets Unicode lookarounds;
// \p{M} keeps a match from ending in front of a matra.
const L = '(?<![\\p{L}\\p{M}\\p{N}_])', R = '(?![\\p{L}\\p{M}\\p{N}_])'
const wrap = (body: string) => new RegExp(`${L}(?:${body.normalize('NFC')})${R}`, 'giu')

const CONDITIONS = 'blood sugar|sugar levels|diabetes|cholesterol|blood pressure|bp|weight|belly fat|acidity|pain|stress|cough|cold|fever|acne|pimples|dandruff|hair fall|constipation|indigestion'
const DISEASE_RE = wrap('diabetes|cancer|heart disease|blood pressure|cholesterol|obesity|weight loss|arthritis|asthma|kidney stones|मधुमेह|कैंसर')
const FOODISH = new Set(['food', 'beverage', 'health'])

type PatternSet = { kind: ClaimKind; res: RegExp[]; when?: (p: TvcPlan) => boolean }
const PATTERNS: PatternSet[] = [
  { kind: 'superlative', res: [
    wrap("no\\.?\\s?1|number\\s+one|#\\s?1"),
    wrap('best[-\\s]?sell(?:ing|ers?)|bestsellers?'),
    wrap('the\\s+best\\s+\\p{L}+\\s+(?:in|of|for)'),
    wrap('best\\s+in\\s+(?:india|class|the\\s+world|town)'),
    wrap("india['’]?s\\s+(?:favou?rite|most\\s+\\p{L}+|best)"),
    wrap('most\\s+(?:trusted|loved|preferred|popular|recommended)'),
    wrap('market\\s+leader'),
    wrap('sabse\\s+(?:best|acch?a|badh?iya)'),
    wrap('नंबर\\s?(?:1|१|वन)'),
    wrap('सबसे\\s+(?:अच्छा|अच्छी|बढ़िया|ज़्यादा|ज्यादा)'),
  ] },
  { kind: 'number', res: [
    wrap('(?!100(?:\\.0+)?\\s?%)\\d+(?:[.,]\\d+)?\\s?%'),
    wrap('\\d+(?:\\.\\d+)?\\s?(?:x|times)'),
    wrap('\\d+\\s?गुना'),
    wrap('in\\s+(?:just\\s+)?\\d+\\s+(?:days?|hours?|minutes?|mins?|weeks?|seconds?)'),
    wrap('\\d+\\s?दिनों\\s+में'),
    wrap('\\d+\\s+(?:out\\s+of|in)\\s+\\d+'),
  ] },
  { kind: 'proven', res: [
    wrap('(?:clinically|dermatologically|scientifically|medically)\\s+(?:proven|tested|approved)'),
    wrap('lab[-\\s]tested'),
    wrap('proven'),
    wrap('certified\\s+by'),
  ] },
  { kind: 'endorsement', res: [
    wrap("(?:doctors?|dentists?|dermatologists?|experts?|pa?ediatricians?)['’]?\\s*(?:recommended|approved|trusted|choice)"),
    wrap('(?:recommended|approved|endorsed)\\s+by'),
    wrap('डॉक्टर(?:ों)?\\s+(?:द्वारा|की\\s+सलाह)'),
  ] },
  { kind: 'absolute', res: [
    wrap('100\\s?%|100\\s+per\\s?cent'),
    wrap('guaranteed?|guarantees'),
    wrap('zero\\s+(?:sugar|fat|calories|cholesterol|germs|bacteria|chemicals|preservatives|side\\s+effects|trans\\s+fat|added\\s+sugar)'),
    wrap('(?:never|always)\\s+(?:fails?|breaks?|fades?|lasts?|works?|leaks?|smudges?|cracks?|rusts?)'),
    wrap('permanently'),
  ] },
  { kind: 'absolute', when: (p) => FOODISH.has(p.brief.category), res: [wrap('pure|शुद्ध')] },
  { kind: 'health', res: [
    wrap('cures?|heals?|prevents?'),
    wrap('immunity'),
    wrap('relief\\s+from|remed(?:y|ies)'),
    wrap(`(?:controls?|reduces?|manages?|lowers?)\\s+(?:${CONDITIONS})`),
    wrap(`treats?\\s+(?:${CONDITIONS})`),
    wrap('इलाज|रोग\\s+प्रतिरोधक'),
  ] },
  { kind: 'health', when: (p) => p.brief.category === 'health', res: [wrap('treats?')] },
]
const ORDER = (k: ClaimKind) => CLAIM_KINDS.indexOf(k)

// "." ends a clause only before whitespace or the end, so "No.1", "₹4.99",
// "2.5x" and "99.9%" stay whole (I3).
const boundaryAt = (t: string, i: number) => /[,;:!?।\n]/u.test(t[i]) || (t[i] === '.' && (i + 1 >= t.length || /\s/.test(t[i + 1])))

function clauseText(original: string, start: number, end: number): string {
  let s = start; while (s > 0 && !boundaryAt(original, s - 1)) s--
  let e = end; while (e < original.length && !boundaryAt(original, e)) e++
  const tokens = [...original.slice(s, e).matchAll(/\S+/gu)].map((m) => ({ from: s + m.index!, to: s + m.index! + m[0].length }))
  if (tokens.length <= 12) return original.slice(s, e).trim()
  const mi = Math.max(0, tokens.findIndex((t) => t.to > start))
  let mj = tokens.length - 1; while (mj > mi && tokens[mj].from >= end) mj--
  let lo = Math.max(0, mi - 6), hi = Math.min(tokens.length, mj + 7)
  while (hi - lo > 12) { if (mi - lo > hi - 1 - mj) lo++; else hi-- }
  return original.slice(tokens[lo].from, tokens[hi - 1].to)
}

function maskBrand(text: string, brand: string | undefined): string {
  if (!brand?.trim()) return text
  const escaped = prepare(brand).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(escaped, 'giu'), (m) => ' '.repeat(m.length))
}

type Hit = { kind: ClaimKind; text: string; health: boolean }
function scanText(plan: TvcPlan, raw: string): Hit[] {
  const original = prepare(raw)
  const masked = maskBrand(original, plan.brief.brandName)
  const groups = new Map<string, Hit>()
  for (const set of PATTERNS) {
    if (set.when && !set.when(plan)) continue
    for (const re of set.res) {
      re.lastIndex = 0
      for (const m of masked.matchAll(re)) {
        const text = clauseText(original, m.index!, m.index! + m[0].length)
        const prev = groups.get(text)
        if (!prev) groups.set(text, { kind: set.kind, text, health: set.kind === 'health' })
        else {
          if (ORDER(set.kind) < ORDER(prev.kind)) prev.kind = set.kind
          if (set.kind === 'health') prev.health = true
        }
      }
    }
  }
  return [...groups.values()]
}

const r1 = (n: number) => Math.round(n * 10) / 10

/** Every claim in the plan, merged by key, in the order first seen. */
export function findClaims(plan: TvcPlan): Finding[] {
  const out = new Map<string, Finding>()
  const starts = shotStarts(plan)
  const india = plan.brief.market === 'india'
  const add = (raw: string | undefined, where: Where) => {
    if (!raw?.trim()) return
    for (const hit of scanText(plan, raw)) {
      const key = claimKey(hit.text)
      const f = out.get(key)
      if (f) { f.where.push(where); if (ORDER(hit.kind) < ORDER(f.kind)) f.kind = hit.kind }
      else out.set(key, { text: hit.text, key, kind: hit.kind, where: [where] })
      const found = out.get(key)!
      if (india && hit.health) { DISEASE_RE.lastIndex = 0; if (DISEASE_RE.test(prepare(hit.text))) found.likelyBanned = true }
    }
  }
  plan.voiceover.forEach((b, i) => add(b.text, { place: 'voiceover', ref: i + 1, startSeconds: b.startSeconds }))
  plan.shots.forEach((s, i) => {
    if (s.audio === 'line') add(s.line, { place: 'line', ref: s.n, startSeconds: starts[i] })
    add(s.text, { place: 'shot_text', ref: s.n, startSeconds: starts[i] })
    add(s.price?.note, { place: 'price_note', ref: s.n, startSeconds: starts[i] })
  })
  const packIdx = plan.shots.findIndex((s) => s.type === 'packshot')
  const packStart = packIdx >= 0 ? starts[packIdx] : plan.brief.lengthSeconds
  add(plan.packshot.tagline, { place: 'tagline', startSeconds: packStart })
  const jingle = plan.brief.jingle
  if (jingle) {
    const packDur = packIdx >= 0 ? plan.shots[packIdx].durationSeconds : 2
    const at = signoffTiming(plan)?.signoffStartSeconds ?? r1(plan.brief.lengthSeconds - estimateSignoffSeconds(jingle.line, packDur))
    for (const l of [...(jingle.lyrics ?? []), jingle.line]) add(l, { place: 'jingle', startSeconds: at })
  }
  // D10: listed in the summary, never asked about.
  plan.shots.forEach((s, i) => {
    if (s.price?.mrp) {
      const text = `${s.price.amount} (MRP ${s.price.mrp})`
      out.set(`offer:${s.n}`, { text, key: claimKey(text), kind: 'offer', where: [{ place: 'offer', ref: s.n, startSeconds: starts[i] }], informational: true })
    }
  })
  plan.shots.forEach((s, i) => {
    if (s.type === 'mechanism' || s.type === 'superpower') {
      const text = s.action.trim().split(/\s+/).slice(0, 12).join(' ')
      out.set(`visual:${s.n}`, { text, key: claimKey(text), kind: 'visual', where: [{ place: 'visual', ref: s.n, startSeconds: starts[i] }], informational: true })
    }
  })
  return [...out.values()]
}

/** C2 + D9: the plan's answers, merged before validation. Inherited (a
 *  cutdown's original) first, then this plan's previous version, then what
 *  Director sent; the incoming entry wins. A new or changed incoming entry is
 *  kept only when the user answered it (Ask) or it is no_proof (Auto);
 *  `answers` undefined means a caller outside the tool, with no gate. */
export function mergeClaims(args: { inherited: ClaimEntry[]; previous: ClaimEntry[]; incoming: ClaimEntry[]; answers?: Set<string>; auto: boolean }): { entries: ClaimEntry[]; warnings: string[]; fromPrevious: Set<string> } {
  const known = new Map<string, ClaimEntry>()
  for (const e of [...args.inherited, ...args.previous]) known.set(claimKey(e.text), e)
  const fromPrevious = new Set(args.previous.map((e) => claimKey(e.text)))
  const warnings: string[] = []
  for (const e of args.incoming) {
    const k = claimKey(e.text)
    const before = known.get(k)
    const changed = !before || before.status !== e.status || (before.proof ?? '') !== (e.proof ?? '')
    if (changed && args.answers !== undefined) {
      const allowed = args.auto ? e.status === 'no_proof' : args.answers.has(k)
      if (!allowed) { warnings.push(`CLAIM_NOT_FROM_USER: "${e.text}" was not answered by the user; ask them`); continue }
    }
    known.set(k, e)
  }
  return { entries: [...known.values()], warnings, fromPrevious }
}

/** After validation: what is still to ask, what is answered and the warnings. */
export function reviewClaims(plan: TvcPlan, entries: ClaimEntry[], fromPrevious: Set<string>): { claims: ClaimEntry[]; toReview: Finding[]; warnings: string[] } {
  const findings = findClaims(plan).filter((f) => !f.informational)
  const liveKeys = new Set(findings.map((f) => f.key))
  const warnings: string[] = []
  const claims: ClaimEntry[] = []
  for (const e of entries) {
    const k = claimKey(e.text)
    if (liveKeys.has(k)) claims.push(e)
    else if (fromPrevious.has(k)) warnings.push(`CLAIM_DROPPED: "${e.text}" is no longer in the ad`)
  }
  const answered = new Set(claims.map((e) => claimKey(e.text)))
  for (const e of claims) if (e.status === 'no_proof') warnings.push(`CLAIM_NO_PROOF: "${e.text}" is kept without proof; the claims summary lists it under Needs proof before airing`)
  for (const f of findings) if (f.likelyBanned) warnings.push(`CLAIM_LIKELY_BANNED: "${f.text}" may not be allowed (Drugs and Magic Remedies Act 1954); check with a lawyer before airing`)
  return { claims, toReview: findings.filter((f) => !answered.has(f.key)), warnings }
}

/** D9: the keys of the user's answers in Olmo's delegation, or undefined. */
export function parseClaimAnswers(prompt: string): string[] | undefined {
  const keys = [...prompt.matchAll(/^\s*Claims:\s*["“](.+?)["”]\s*=/gimu)].map((m) => claimKey(m[1]))
  return keys.length ? keys : undefined
}
