import { countWords, legalTimings, shotStarts, type TvcPlan } from './tvcPlan.js'
import { claimKey, type ClaimEntry, type Finding, type Where } from './claims.js'

// Part 2.6: the claims summary (spec §The summary). A checklist made from the
// plan, never "compliant"; the user signs off.

const SDC_CATEGORIES = new Set(['food', 'beverage', 'health'])
export const sdcApplies = (p: TvcPlan): boolean => p.brief.market === 'india' && SDC_CATEGORIES.has(p.brief.category)

const tc = (s: number) => { const m = Math.floor(s / 60); return `[${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}]` }
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
const categoryWord = (c: string) => c.replace(/_/g, ' ')
export const productLabel = (p: TvcPlan): string => p.brief.productName?.trim() || `${p.brief.brandName ?? 'The product'} ${categoryWord(p.brief.category)}`

const placeLabel = (w: Where) => ({
  voiceover: `voiceover ${w.ref}`, line: `shot ${w.ref} line`, shot_text: `shot ${w.ref} text`, price_note: `shot ${w.ref} price note`,
  tagline: 'tagline', jingle: 'jingle', offer: `shot ${w.ref} price`, visual: `shot ${w.ref}`,
}[w.place])

const entriesByKey = (p: TvcPlan) => new Map((p.claims ?? []).map((e) => [claimKey(e.text), e] as const))

type NeedsProof = { text: string; why: string }
function needsProofItems(p: TvcPlan, findings: Finding[]): NeedsProof[] {
  const byKey = entriesByKey(p)
  const items: NeedsProof[] = []
  for (const f of findings.filter((x) => !x.informational)) {
    const e = byKey.get(f.key)
    if (!e) items.push({ text: f.text, why: 'not reviewed' })
    else if (e.status === 'no_proof') items.push({ text: f.text, why: 'kept without proof' })
    if (f.likelyBanned) items.push({ text: f.text, why: 'may not be allowed (Drugs and Magic Remedies Act 1954); check with a lawyer' })
  }
  return items
}

export function summaryCounts(p: TvcPlan, findings: Finding[]): { needsProof: number; unreviewed: number } {
  const byKey = entriesByKey(p)
  const live = findings.filter((f) => !f.informational)
  const needs = new Set(needsProofItems(p, findings).map((i) => claimKey(i.text)))
  return { needsProof: needs.size, unreviewed: live.filter((f) => !byKey.has(f.key)).length }
}

function disclaimerFor(p: TvcPlan, f: Finding): string {
  const timings = legalTimings(p).timings
  const starts = shotStarts(p)
  const out = new Set<string>()
  for (const w of f.where) {
    p.legal.forEach((l, i) => {
      const t = timings[i]
      if (!t || l.wholeAd || l.auto) return
      if (w.place === 'voiceover' && l.forVoiceoverBlock === w.ref) out.add(l.text)
      else if (w.place !== 'voiceover') {
        const idx = w.ref !== undefined ? p.shots.findIndex((s) => s.n === w.ref) : -1
        const from = idx >= 0 ? starts[idx] : w.startSeconds
        const to = idx >= 0 ? from + p.shots[idx].durationSeconds : p.brief.lengthSeconds
        if (t.startSeconds < to && t.endSeconds > from) out.add(l.text)
      }
    })
  }
  return [...out].join('; ') || '—'
}

const proofCell = (e: ClaimEntry | undefined) => (!e ? 'Not reviewed' : e.status === 'proof' ? (e.proof ?? '') : 'None — needs proof')

const GLOSS: Record<string, string> = {
  hook: 'It opens on an attention-grabbing moment.', reaction: 'A person reacts to the product.', hero: 'The product is shown in a hero shot.',
  lifestyle: 'People enjoy the product in everyday life.', reach: 'A hand reaches for the product.', product_macro: 'A close-up shows the product in detail.',
  mechanism: 'A stylised shot shows how the product works, marked as creative visualisation where shown.',
  superpower: 'A stylised shot shows the product\'s effect, marked as creative visualisation where shown.', packshot: 'It ends on the product and the brand.',
}
const PADDING = [
  'The full script, with every voiceover line, on-screen text and disclaimer, is listed with this description.',
  'The film was made from approved still frames and generated video, then edited with text, music and voice.',
  'Each claim above is shown with its disclaimer where the plan requires one.',
  'The advertiser checks these details before submitting the declaration.',
  'Music and a closing brand moment complete the film.',
]

/** I9: required sentences (product, message, format, every claim), then the
 *  optional ones in priority order until at least 100 words, never past 200. */
export function sdcDescription(p: TvcPlan, findings: Finding[]): string {
  const byKey = entriesByKey(p)
  const brand = p.brief.brandName
  const required = [
    `The advertisement is for ${productLabel(p)}${brand ? `, sold under the ${brand} brand` : ''}, a ${categoryWord(p.brief.category)} product.`,
    `Its single message is: "${p.brief.message}".`,
    `It is a ${p.brief.lengthSeconds}-second film in ${p.brief.aspectRatio === '16:9' ? 'landscape (16:9)' : 'vertical (9:16)'} format, made for ${p.brief.market === 'india' ? 'Indian' : 'general'} audiences.`,
  ]
  const claims = findings.filter((f) => !f.informational && byKey.get(f.key)?.status !== 'not_a_claim').map((f) => {
    const e = byKey.get(f.key)
    const how = !e ? 'this claim has not been reviewed yet' : e.status === 'proof' ? `the advertiser holds: ${e.proof}` : 'no substantiation has been provided yet'
    return `It claims "${f.text}"; ${how}.`
  })
  const words = (xs: string[]) => countWords(xs.join(' '))
  const out = [...required]
  if (claims.length === 0) out.push('It makes no specific product claims beyond the brand message.')
  for (const c of claims) {
    if (words([...out, c, 'Further claims are listed in the claims table.']) > 200) { out.push('Further claims are listed in the claims table.'); break }
    out.push(c)
  }
  const optional = [
    ...(p.voiceover.length ? [`The voiceover says: "${p.voiceover.map((v) => v.text.trim()).join(' ')}".`] : []),
    ...(p.packshot.tagline ? [`The closing tagline reads "${p.packshot.tagline}".`] : []),
    ...(p.brief.jingle ? [`It ends with a sung line: "${p.brief.jingle.line}".`] : []),
    ...[...new Set(p.shots.map((s) => GLOSS[s.type]).filter(Boolean))],
    ...PADDING,
  ]
  for (const s of optional) {
    if (words(out) >= 100) break
    if (words([...out, s]) > 200) continue
    out.push(s)
  }
  const text = out.join(' ')
  return countWords(text) > 200 ? text.split(/\s+/).slice(0, 200).join(' ') : text
}

function scriptLines(p: TvcPlan): string[] {
  const starts = shotStarts(p)
  const rows: Array<{ t: number; s: string }> = []
  p.voiceover.forEach((v) => rows.push({ t: v.startSeconds, s: `Voiceover: ${v.text}` }))
  p.shots.forEach((sh, i) => {
    if (sh.audio === 'line' && sh.line) rows.push({ t: starts[i], s: `On camera (shot ${sh.n}): ${sh.line}` })
    if (sh.text) rows.push({ t: starts[i], s: `On screen (shot ${sh.n}): ${sh.text}` })
    if (sh.price) rows.push({ t: starts[i], s: `Price (shot ${sh.n}): ${sh.price.amount}${sh.price.mrp ? ` (MRP ${sh.price.mrp})` : ''}${sh.price.note ? ` — ${sh.price.note}` : ''}` })
  })
  legalTimings(p).timings.forEach((t) => { if (t) rows.push({ t: t.startSeconds, s: `Disclaimer (until ${tc(t.endSeconds)}): ${t.text}` }) })
  const packIdx = p.shots.findIndex((s) => s.type === 'packshot')
  const packStart = packIdx >= 0 ? starts[packIdx] : p.brief.lengthSeconds
  if (p.packshot.tagline) rows.push({ t: packStart, s: `Tagline: ${p.packshot.tagline}` })
  if (p.brief.jingle) for (const l of [...(p.brief.jingle.lyrics ?? []), p.brief.jingle.line]) rows.push({ t: packStart, s: `Sung: ${l}` })
  return rows.map((r, i) => ({ ...r, i })).sort((a, b) => a.t - b.t || a.i - b.i).map((r) => `- ${tc(r.t)} ${r.s}`)
}

export function claimsSummaryMarkdown(p: TvcPlan, findings: Finding[], opts: { now: Date }): string {
  const byKey = entriesByKey(p)
  const live = findings.filter((f) => !f.informational)
  const listed = live.filter((f) => byKey.get(f.key)?.status !== 'not_a_claim')
  const notClaims = live.filter((f) => byKey.get(f.key)?.status === 'not_a_claim')
  const info = findings.filter((f) => f.informational)
  const india = p.brief.market === 'india'
  const L: string[] = []
  L.push(`# Claims summary — ${productLabel(p)}`, '')
  L.push(`Ad: ${p.brief.lengthSeconds}s, ${p.brief.aspectRatio}, ${p.brief.market} market`, `Made: ${opts.now.toISOString().slice(0, 10)}`, '')
  L.push('## Needs proof before airing', '')
  const needs = needsProofItems(p, findings)
  if (needs.length) needs.forEach((n) => L.push(`- ${n.text} — ${n.why}`))
  else L.push('Nothing flagged.')
  L.push('', '## Claims', '')
  if (listed.length) {
    L.push('| Phrase | Kind | Where | Disclaimer | Proof |', '|---|---|---|---|---|')
    for (const f of listed) L.push(`| ${cell(f.text)} | ${f.kind} | ${cell(f.where.map((w) => `${placeLabel(w)} ${tc(w.startSeconds)}`).join('; '))} | ${cell(disclaimerFor(p, f))} | ${cell(proofCell(byKey.get(f.key)))} |`)
  } else L.push('No claims found.')
  const whole = p.legal.filter((l) => l.wholeAd)
  if (whole.length) L.push('', `Whole-ad disclaimer: ${whole.map((l) => l.text).join('; ')}`)
  L.push('', '## Also in the ad', '')
  if (info.length) {
    const auto = p.legal.find((l) => l.auto)
    info.forEach((f) => L.push(`- ${f.kind === 'offer' ? 'Offer' : 'Product shown working'}: ${f.text} (${f.where.map((w) => `${placeLabel(w)} ${tc(w.startSeconds)}`).join('; ')})${f.kind === 'visual' && auto ? ` — "${auto.text}" on screen` : ''}`))
  } else L.push('Nothing else.')
  L.push('', '## Reviewed, not claims', '')
  if (notClaims.length) notClaims.forEach((f) => L.push(`- ${f.text}`))
  else L.push('None.')
  if (sdcApplies(p)) L.push('', '## SDC description', '', sdcDescription(p, findings))
  L.push('', '## Full script', '', ...scriptLines(p))
  if (sdcApplies(p)) {
    L.push('', '## SDC checklist', '',
      '- Portal: Broadcast Seva for TV and radio; the Press Council of India portal for print and internet.',
      '- An authorised representative, with a Letter of Authorisation on the company letterhead.',
      '- A valid mobile number and email address for that representative.',
      '- The full script as a PDF (print the Full script section above to PDF).',
      '- A URL of the ad video.',
      '- The proposed date of first broadcast.',
      '- A CBFC certificate and GST details, if available.',
      '',
      'Since July 2024 the MIB has asked for this once a year for food and health ads; check the portal for the current rule.')
  }
  L.push('', '---', '', `A checklist made from the ad plan, not legal advice.${india ? ' ASCI can ask for proof of any claim at any time.' : ''} You sign off.`)
  return L.join('\n') + '\n'
}
