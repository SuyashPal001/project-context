import type { Breakdown } from '../tools/videoBreakdown/breakDownVideo.js'
import { askChecked, type AskFn } from '../tools/tvcChecks.js'
import { remakeLooks, personIn, aspectOf, refOf } from './looks.js'
import type { Brand, PlanLine, RemakeLook, RemakePlan, RemakeReference } from './types.js'

type Ref = { ref: string; what: string }

export function planRefs(b: Breakdown, looks: RemakeLook[]): Ref[] {
  const o = b.overview
  const out: Ref[] = [
    { ref: 'story', what: `${o.story.setup} / ${o.story.cause} / ${o.story.payoff}` },
    { ref: 'setting', what: Object.entries(o.setting).map(([k, v]) => `${k}: ${v}`).join('; ') },
  ]
  if (looks.some(personIn)) out.push({ ref: 'cast', what: 'the person on screen' })
  ;(o.characters ?? []).forEach((c, i) => out.push({ ref: `characters[${i}]`, what: c.who }))
  for (const l of looks) {
    if (out.some((r) => r.ref === `looks[${refOf(l)}].outfit`)) continue // a later shot of the same outfit look
    out.push({ ref: `looks[${refOf(l)}].outfit`, what: l.outfit }, { ref: `looks[${refOf(l)}].expression`, what: l.expression })
  }
  o.moments.forEach((m, i) => out.push({ ref: `moments[${i}]`, what: `${m.t_s}s ${m.what}` }))
  o.props.forEach((p, i) => out.push({ ref: `props[${i}]`, what: `${p.prop} (${p.where})` }))
  o.on_screen_text.forEach((t, i) => out.push({ ref: `onScreenText[${i}]`, what: t }))
  out.push({ ref: 'sound.music', what: `${o.music.mood}, ${o.music.genre}` })
  if (o.voice_lines) out.push({ ref: 'sound.voice', what: o.voice_lines })
  out.push({ ref: 'trick', what: o.trick })
  return out
}

/** Code-owned rules (spec §1 non-goals, §9a): no copied music, voice script, reference text or person. */
export function enforceRules(lines: PlanLine[], refs: Ref[], ctx: { brand: Brand; musicMood: string }): { lines: PlanLine[]; warnings: string[] } {
  const known = new Set(refs.map((r) => r.ref))
  const warnings: string[] = []
  const byRef = new Map<string, PlanLine>()
  for (const l of lines) {
    if (!known.has(l.ref)) { warnings.push(`${l.ref}: not part of this video, ignored`); continue }
    if (!byRef.has(l.ref)) byRef.set(l.ref, l)
  }
  const out = refs.map(({ ref }): PlanLine => {
    let l: PlanLine = byRef.get(ref) ?? { ref, action: 'keep', auto: true }
    if (l.action === 'swap' && !l.to?.trim()) { warnings.push(`${ref}: swap had no replacement, kept as the reference`); l = { ref, action: 'keep' } }
    if (ref === 'sound.music' && l.action !== 'swap') {
      if (!l.auto) warnings.push('music: the original track is never copied, so it is replaced with new music in the same mood')
      l = { ref, action: 'swap', to: `new music, same mood: ${ctx.musicMood}` }
    }
    if (ref === 'sound.voice' && l.action === 'keep') {
      if (!l.auto) warnings.push('voice: the original words are never copied, so new words are needed')
      l = { ref, action: 'swap', to: `new words for ${ctx.brand.name}` }
    }
    if (ref.startsWith('onScreenText[') && l.action === 'keep') {
      if (!l.auto) warnings.push(`${ref}: the reference's own text is never copied, so it is left out`)
      l = { ref, action: 'drop', why: 'the reference text is never copied' }
    }
    // Another person in the story is a new person too; dropping them is the user's call.
    if (ref.startsWith('characters[') && l.action === 'keep') {
      const what = refs.find((r) => r.ref === ref)?.what
      l = { ref, action: 'swap', to: `a new person: ${what || 'the same role in the story'}` }
    }
    if (ref === 'cast' && l.action !== 'swap') {
      if (!l.auto) warnings.push('cast: the person is always a new person')
      l = { ref, action: 'swap', to: `a new person who fits ${ctx.brand.audience ?? ctx.brand.name}` }
    }
    return l
  })
  return { lines: out, warnings }
}

export function referenceOf(b: Breakdown): RemakeReference {
  const o = b.overview
  return {
    // Framing is per shot (the guide frame and measured body carry it); a reel-wide framing note in
    // the setting contradicted every still it was copied into (live Snitch run, 2026-10-16).
    setting: Object.entries(o.setting).filter(([k]) => !/framing|camera|shot/i.test(k)).map(([k, v]) => `${k}: ${v}`).join('; '),
    // part_of_trick may come back as true or "true"; only a plain yes counts.
    props: o.props.map((p) => ({ prop: p.prop, where: p.where, when: p.when, ...(p.part_of_trick === true || String(p.part_of_trick) === 'true' ? { trick: true } : {}) })),
    moments: o.moments.map((m) => ({ t_s: m.t_s, what: m.what })),
    characters: o.characters ?? [],
    musicMood: [o.music.mood, o.music.genre].filter(Boolean).join(', '),
    music: { mood: o.music.mood, genre: o.music.genre, instruments: o.music.instruments, hasVocals: o.music.has_vocals, songName: o.music.song_name },
    videoFileId: b.video.fileId, durationS: b.video.durationS, width: b.video.width, height: b.video.height,
  }
}

const brandText = (brand: Brand) => [`name: ${brand.name}`, `product: ${brand.product}`, brand.audience && `audience: ${brand.audience}`, brand.notes && `notes: ${brand.notes}`].filter(Boolean).join('; ')

export async function writePlan(b: Breakdown, brand: Brand, ask: AskFn): Promise<RemakePlan> {
  const looks = remakeLooks(b)
  const refs = planRefs(b, looks)
  const reference = referenceOf(b)
  const v = await askChecked(ask, [{ text: `You plan a remake of a reference video for a brand. For EVERY ref below decide:
- keep: the remake copies it as it is (structure, poses, timing, story beats)
- swap: the remake replaces it with the brand's version; say exactly what in "to"
- drop: leave it out; say why in "why"
Rules: the person on screen, and every other character, is always a new person who fits the brand (describe age range and style only; never a real or famous person; no names). Outfits and props usually swap toward the brand's product and style. Moments, poses and the story's structure are kept. Never write the name of a real person or a character.
BRAND: ${brandText(brand)}
REFS: ${JSON.stringify(refs)}
Also list in "missing_props" every object a look's pose, a move or a moment says the person holds or uses that is NOT in the props refs, with roughly when it is on screen (m:ss - m:ss).
LOOKS: ${JSON.stringify(b.overview.looks.map((l) => ({ start_pose: l.start_pose, end_pose: l.end_pose, moves: (l.moves ?? []).map((m) => `${m.t_s}s ${m.how}`) })))}
Reply ONLY JSON {"lines":[{"ref":"","action":"keep|swap|drop","to":"","why":""}],"missing_props":[{"prop":"","where":"","when":""}]}` }], [{ key: 'lines', type: 'array' }])
  const raw = (v.lines as unknown[])
    .filter((x): x is PlanLine => !!x && typeof x === 'object' && typeof (x as PlanLine).ref === 'string' && ['keep', 'swap', 'drop'].includes((x as PlanLine).action))
    .map((x): PlanLine => ({ ref: x.ref, action: x.action, ...(x.to ? { to: x.to } : {}), ...(x.why ? { why: x.why } : {}) }))
  // An object a pose holds but the props list missed (metro rerun v7: "holding bouquet and phone", no
  // phone prop) is added and kept, so the still draws it and the check expects it.
  const missing = (Array.isArray(v.missing_props) ? v.missing_props : []).filter((x): x is { prop: string; where?: string; when?: string } => !!x && typeof x === 'object' && typeof (x as { prop?: unknown }).prop === 'string' && !!(x as { prop: string }).prop.trim())
    .filter((x) => !reference.props.some((p) => p.prop.toLowerCase() === x.prop.toLowerCase()))
  for (const x of missing) {
    refs.push({ ref: `props[${reference.props.length}]`, what: `${x.prop} (${x.where ?? ''})` })
    reference.props.push({ prop: x.prop, where: x.where ?? '', when: x.when ?? '' })
  }
  const { lines, warnings } = enforceRules(raw, refs, { brand, musicMood: reference.musicMood })
  return { lines, looks, reference, needsCasting: looks.some(personIn), aspectRatio: aspectOf(b), warnings }
}

export function applyEdits(plan: RemakePlan, edits: PlanLine[], brand: Brand): RemakePlan {
  const edited = new Map(edits.map((e) => [e.ref, { ref: e.ref, action: e.action, ...(e.to ? { to: e.to } : {}), ...(e.why ? { why: e.why } : {}) } as PlanLine]))
  const merged = plan.lines.map((l) => edited.get(l.ref) ?? l).concat(edits.filter((e) => !plan.lines.some((l) => l.ref === e.ref)))
  const refs = plan.lines.map((l) => ({ ref: l.ref, what: '' }))
  const { lines, warnings } = enforceRules(merged, refs, { brand, musicMood: plan.reference.musicMood })
  // Earlier warnings still apply after an edit; keep them, new ones after (M7).
  return { ...plan, lines, warnings: [...new Set([...plan.warnings, ...warnings])] }
}
