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

/** F1: the user's answer to one claim question, parsed from Olmo's
 *  delegation. `key` is the flagged phrase's claimKey, never the raw text —
 *  mergeClaims matches an incoming entry by this same key. `proofMissing` is
 *  set when the user picked "I have proof" but gave an empty or placeholder
 *  proof; the answer is still 'no_proof' (never a made-up proof), and
 *  mergeClaims uses the flag only to pick the right warning text. */
export const CLAIM_ANSWER_KINDS = ['proof', 'no_proof', 'not_a_claim', 'soften'] as const
export type ClaimAnswerKind = typeof CLAIM_ANSWER_KINDS[number]
export interface ClaimAnswer { key: string; answer: ClaimAnswerKind; proof?: string; proofMissing?: true }

/** The request-context key hooks.ts sets from Olmo's "Claims:" lines (D9). */
export const TVC_CLAIM_ANSWERS_KEY = 'tvcClaimAnswers'

const prepare = (text: string) => text.normalize('NFC').replace(/[‌‍]/g, '')

/** One claim, one key, however Director or the user typed it (I3). F2: also
 *  folds "No. 1"/"No.1", "# 1"/"#1" and "99 %"/"99%" to the same key — the
 *  whitespace a digit/letter leaves before a following "%", or that "." or
 *  "#" leaves before a following digit, is never meaningful. */
export function claimKey(text: string): string {
  return prepare(text).toLowerCase()
    .replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"')
    .replace(/\s+/g, ' ').trim()
    .replace(/([.#])\s+(?=\d)/gu, '$1')
    .replace(/([\p{L}\p{N}])\s+%/gu, '$1%')
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
    // F4: "The best part of my day" / "The best time of the year" are
    // everyday lines, not claims — excluded by name, not by relaxing the
    // pattern for every other noun ("the best coffee in town" still matches).
    wrap('the\\s+best\\s+(?!part\\b|time\\b)\\p{L}+\\s+(?:in|of|for)'),
    wrap('best\\s+in\\s+(?:india|class|the\\s+world|town)'),
    wrap("india['’]?s\\s+(?:favou?rite|most\\s+\\p{L}+|best)"),
    wrap('most\\s+(?:trusted|loved|preferred|popular|recommended)'),
    wrap('market\\s+leader'),
    wrap('sabse\\s+(?:best|acch?a|badh?iya)'),
    wrap('नंबर\\s?(?:1|१|वन)'),
    wrap('सबसे\\s+(?:अच्छा|अच्छी|बढ़िया|ज़्यादा|ज्यादा)'),
  ] },
  { kind: 'number', res: [
    // F4: "Incl. 18% GST" / "18% tax" are never claims — a % immediately
    // (optionally with a space) before gst/tax/vat is a tax note, not a
    // performance number.
    wrap('(?!100(?:\\.0+)?\\s?%)\\d+(?:[.,]\\d+)?\\s?%(?!\\s*(?:gst|tax|vat))'),
    // F4: "Open 24 x 7" / "Pack of 6 x 200 ml" are never claims — only an "x"
    // directly against the number ("2x", "2.5x") is a multiplier claim; a
    // space before it is a dimension/hours separator. "times" still allows
    // (needs) a space, e.g. "3 times".
    wrap('\\d+(?:\\.\\d+)?x'),
    wrap('\\d+(?:\\.\\d+)?\\s+times'),
    wrap('\\d+\\s?गुना'),
    wrap('in\\s+(?:just\\s+)?\\d+\\s+(?:days?|hours?|minutes?|mins?|weeks?|seconds?)'),
    wrap('\\d+\\s?दिनों\\s+में'),
    wrap('\\d+\\s+out\\s+of\\s+\\d+'),
    // F4: "2 in 1 shampoo" is a product descriptor, not a claim — "N in 1"
    // is excluded; "4 in 5 doctors" and "1 in 3 Indians" stay claims.
    wrap('\\d+\\s+in\\s+(?!1(?!\\d))\\d+'),
  ] },
  { kind: 'proven', res: [
    wrap('(?:clinically|dermatologically|scientifically|medically)[\\s-]+(?:proven|tested|approved)'),
    wrap('lab[-\\s]tested'),
    // F4: "Time-proven recipe" is an everyday line, not a claim; only
    // "time-proven" is excluded, so "Lab-proven results" stays a claim.
    wrap('(?<!time-)proven'),
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
    // F4: "Instant relief from the summer heat" is an everyday line — "relief
    // from" is a health claim only when it names a condition (the same list
    // the likelyBanned check uses), so "relief from acidity" still matches.
    wrap(`relief\\s+from\\s+(?:${CONDITIONS})|remed(?:y|ies)`),
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

/** C2 + D9 (F1): the plan's answers, merged before validation. Inherited (a
 *  cutdown's original) first, then this plan's previous version, then what
 *  Director sent; the incoming entry wins. An unchanged incoming entry (same
 *  status+proof as stored) passes without an answer. A new or changed one is
 *  gated on WHAT the user answered, not just that a key was mentioned: in Ask
 *  mode the stored status/proof come from the user's own answer, never from
 *  Director's entry (D9's "the STORED entry takes status and proof FROM THE
 *  USER'S ANSWER"). `answers` undefined means a caller outside the tool, with
 *  no gate. `fromIncoming` (F2) is every key accepted this call from
 *  `args.incoming` — reviewClaims uses it to tell a typo'd phrase
 *  (CLAIM_NO_MATCH) from a stale one dropped from the ad (CLAIM_DROPPED). */
export function mergeClaims(args: { inherited: ClaimEntry[]; previous: ClaimEntry[]; incoming: ClaimEntry[]; answers?: Map<string, ClaimAnswer>; auto: boolean }): { entries: ClaimEntry[]; warnings: string[]; fromPrevious: Set<string>; fromIncoming: Set<string> } {
  const known = new Map<string, ClaimEntry>()
  for (const e of [...args.inherited, ...args.previous]) known.set(claimKey(e.text), e)
  const fromPrevious = new Set(args.previous.map((e) => claimKey(e.text)))
  const fromIncoming = new Set<string>()
  const warnings: string[] = []
  for (const e of args.incoming) {
    const k = claimKey(e.text)
    const before = known.get(k)
    const changed = !before || before.status !== e.status || (before.proof ?? '') !== (e.proof ?? '')
    // An unchanged entry passes without an answer, unless the user just gave
    // a new answer for it (Ask mode): then the answer below wins.
    const freshAnswer = args.answers !== undefined && !args.auto && args.answers.has(k)
    if (!changed && !freshAnswer) { known.set(k, e); fromIncoming.add(k); continue }
    if (args.answers === undefined) { known.set(k, e); fromIncoming.add(k); continue }
    if (args.auto) {
      if (e.status === 'no_proof') { known.set(k, e); fromIncoming.add(k) }
      else warnings.push(`CLAIM_NOT_FROM_USER: "${e.text}" was not answered by the user; ask them`)
      continue
    }
    const ans = args.answers.get(k)
    if (!ans) {
      // D9: Director re-sent an already-answered key with no new user
      // answer (possibly with a different, made-up proof) — keep the user's
      // stored answer rather than silently dropping it or trusting Director.
      if (before) { known.set(k, before); fromIncoming.add(k); warnings.push(`CLAIM_KEPT: "${e.text}" already has the user's answer; it was kept`) }
      else warnings.push(`CLAIM_NOT_FROM_USER: "${e.text}" was not answered by the user; ask them`)
      continue
    }
    if (ans.answer === 'soften') {
      // D9: a soften answer means Director should have rewritten the phrase
      // so it no longer matches; an entry for it is dropped, naming soften.
      warnings.push(`CLAIM_NOT_FROM_USER: "${e.text}" was answered "soften"; the phrase should have been rewritten, not kept as an entry`)
      continue
    }
    if (ans.proofMissing) warnings.push(`CLAIM_PROOF_MISSING: "${e.text}" was answered "I have proof" with no proof given; kept as no proof — ask the user what the proof is`)
    const status: ClaimStatus = ans.answer === 'proof' ? 'proof' : ans.answer === 'no_proof' ? 'no_proof' : 'not_a_claim'
    const proof = status === 'proof' && !ans.proofMissing ? ans.proof : undefined
    known.set(k, { text: e.text, status, ...(proof ? { proof } : {}) })
    fromIncoming.add(k)
  }
  return { entries: [...known.values()], warnings, fromPrevious, fromIncoming }
}

// F2: a cheap "nearest live finding" hint for CLAIM_NO_MATCH — shares at
// least one word (3+ letters, case-insensitive) with the entry's text; the
// finding with the most shared words wins. Purely a courtesy in the warning
// text, never used to match or merge.
function nearestLiveFinding(text: string, findings: Finding[]): string | undefined {
  const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
  const target = words(text)
  if (!target.size) return undefined
  let best: { text: string; score: number } | undefined
  for (const f of findings) {
    const score = [...words(f.text)].filter((w) => target.has(w)).length
    if (score > 0 && (!best || score > best.score)) best = { text: f.text, score }
  }
  return best?.text
}

/** After validation: what is still to ask, what is answered and the
 *  warnings. `fromIncoming` (F2) marks entries this check's own incoming
 *  claims brought in: one of those with no live finding gets CLAIM_NO_MATCH
 *  (likely a typo'd phrase) instead of silence or CLAIM_DROPPED — the latter
 *  stays for a stale entry merely carried over from an earlier version. */
export function reviewClaims(plan: TvcPlan, entries: ClaimEntry[], fromPrevious: Set<string>, fromIncoming: Set<string> = new Set()): { claims: ClaimEntry[]; toReview: Finding[]; warnings: string[] } {
  const findings = findClaims(plan).filter((f) => !f.informational)
  const liveKeys = new Set(findings.map((f) => f.key))
  const warnings: string[] = []
  const claims: ClaimEntry[] = []
  for (const e of entries) {
    const k = claimKey(e.text)
    if (liveKeys.has(k)) claims.push(e)
    else if (fromIncoming.has(k)) {
      const nearest = nearestLiveFinding(e.text, findings)
      warnings.push(`CLAIM_NO_MATCH: "${e.text}" matches no flagged phrase; use the phrase exactly as plan_tvc returned it${nearest ? `: "${nearest}"` : ''}`)
    }
    else if (fromPrevious.has(k)) warnings.push(`CLAIM_DROPPED: "${e.text}" is no longer in the ad`)
  }
  const answered = new Set(claims.map((e) => claimKey(e.text)))
  for (const e of claims) if (e.status === 'no_proof') warnings.push(`CLAIM_NO_PROOF: "${e.text}" is kept without proof; the claims summary lists it under Needs proof before airing`)
  for (const f of findings) if (f.likelyBanned) warnings.push(`CLAIM_LIKELY_BANNED: "${f.text}" may not be allowed (Drugs and Magic Remedies Act 1954); check with a lawyer before airing`)
  return { claims, toReview: findings.filter((f) => !answered.has(f.key)), warnings }
}

// F1/F2: an empty or placeholder proof is never a real proof — "proof: none"
// (or blank, "n/a", "na", "-", "not given", "(not given)", "nothing", "no",
// "tbd") is treated the same as not giving one.
const PLACEHOLDER_PROOFS = new Set(['', 'none', 'n/a', 'na', '-', 'not given', 'nothing', 'no', 'tbd'])
function isPlaceholderProof(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/^[([]+|[)\]]+$/g, '').replace(/[.,;:!?]+$/g, '').trim()
  return PLACEHOLDER_PROOFS.has(t)
}

// F2: tolerate a leading list/bold marker before "Claims:" ("- ", "* ",
// "• ", "1. ", "1) ", "**Claims:**"), and straight or curly single/double
// quotes around the phrase. Each line is its own match (several answers on
// one line, separated by " ; " or " | ", is not parsed — see the final-fix
// report: a Director-authored separator inside the proof text itself could
// be mistaken for one, so it is left as a gap rather than guessed at).
const CLAIMS_LINE_RE = /^[ \t]*(?:[-*•]\s+|\d+[.)]\s+)?\*{0,2}Claims:\*{0,2}\s*["“'‘](.+?)["”'’]\s*=\s*(.+?)\s*$/gimu

/** D9/F1: the user's answers in Olmo's delegation, one per "Claims:" line,
 *  or undefined when there are none. */
export function parseClaimAnswers(prompt: string): ClaimAnswer[] | undefined {
  const out: ClaimAnswer[] = []
  for (const m of prompt.matchAll(CLAIMS_LINE_RE)) {
    const key = claimKey(m[1])
    const rhs = m[2].trim()
    const proofMatch = /^proof\s*:\s*(.*)$/i.exec(rhs)
    if (proofMatch) {
      const proofText = proofMatch[1].trim()
      if (isPlaceholderProof(proofText)) out.push({ key, answer: 'no_proof', proofMissing: true })
      else out.push({ key, answer: 'proof', proof: proofText })
      continue
    }
    const rhsLower = rhs.toLowerCase()
    // The keyword that comes first wins: "not a claim, do not soften" is
    // not_a_claim, "Not a claim (no proof needed)" is not_a_claim.
    const hits = ([['soften', /soften/], ['no_proof', /no[\s_-]?proof/], ['not_a_claim', /not[\s_-]+a[\s_-]+claim/]] as const)
      .map(([answer, re]) => ({ answer, at: re.exec(rhsLower)?.index ?? -1 }))
      .filter((h) => h.at >= 0)
      .sort((a, b) => a.at - b.at)
    if (hits.length) out.push({ key, answer: hits[0].answer })
  }
  return out.length ? out : undefined
}
