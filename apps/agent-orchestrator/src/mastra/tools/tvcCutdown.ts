import { BRAND_BY, EPS, MAX_SHOTS, PACK_MIN, PRODUCT_BY, SHOT_MIN, cutError, jingleErrors, shotStarts, type TvcPlan, type TvcShot } from './tvcPlan.js'

// Part 2.4: shorter versions (cutdowns) of a finished TVC, made from its own
// recorded clips with no new generation (spec 2026-10-10-tvc-cutdowns-design.md).
// Code picks the shots and fits their lengths; Director writes only the
// shorter script. Pure: no I/O, so plan_tvc and the tests share it.

export const CUTDOWN_LENGTHS = [6, 15, 20]
// The pace of a normal plan of that length. The picker starts here and allows
// more moments only when the original's shots are too short to fill the length.
export const CUTDOWN_MAX_SHOTS: Record<number, number> = { 6: 3, 15: 8, 20: 10 }
const TYPE_WEIGHT: Record<TvcShot['type'], number> = {
  hook: 10, hero: 8, product_macro: 7, superpower: 6, reaction: 5, mechanism: 5, lifestyle: 4, reach: 3, packshot: 0,
}
const T = (x: number) => Math.round(x * 10)
const r1 = (x: number) => Math.round(x * 10) / 10

export const shotScore = (s: TvcShot): number =>
  TYPE_WEIGHT[s.type] + (s.price ? 6 : 0) + (s.productVisible ? 3 : 0) + (s.brandVisible ? 2 : 0)

/** D3: why a kept shot must keep its original length, or null when it may be shortened. */
export function fixedLengthReason(master: TvcPlan, s: TvcShot, hasJingle = !!master.brief.jingle): string | null {
  if (s.audio === 'line') return 'it has an on-camera line'
  if (s.flashCut) return 'it is a flash cut'
  if (s.continuesFrom !== undefined || master.shots.some((o) => o.continuesFrom === s.n)) return 'it is part of a continuing shot'
  if (s.type === 'packshot' && hasJingle) return 'the sung sign-off plays over it'
  return null
}

/** The shortest a kept shot may become: its own length when fixed, the packshot 2s, any other shot 1.2s (0.6s when the original matched a reference's cuts), and never under 1.2s for a shot with a price (PRICE_TOO_SHORT). */
export function minCutdownSeconds(master: TvcPlan, s: TvcShot, hasJingle = !!master.brief.jingle): number {
  if (fixedLengthReason(master, s, hasJingle)) return s.durationSeconds
  if (s.type === 'packshot') return Math.min(s.durationSeconds, PACK_MIN)
  const floor = Math.max(master.brief.reference?.cutTimes?.length ? 0.6 : SHOT_MIN, s.price ? SHOT_MIN : 0)
  return Math.min(s.durationSeconds, floor)
}

/** Shortens the kept shots to exactly lengthSeconds, 0.1s at a time from the
 *  shot with the most room left (the earliest on a tie). An unshortened shot
 *  keeps its exact original value. null when they can't add up to it. */
export function fitDurations(master: TvcPlan, kept: TvcShot[], lengthSeconds: number, hasJingle = !!master.brief.jingle): number[] | null {
  const cur = kept.map((s) => T(s.durationSeconds))
  const min = kept.map((s) => T(minCutdownSeconds(master, s, hasJingle)))
  const target = T(lengthSeconds)
  if (min.reduce((a, b) => a + b, 0) > target) return null
  let excess = cur.reduce((a, b) => a + b, 0) - target
  if (excess < 0) return null
  while (excess > 0) {
    let best = -1
    for (let i = 0; i < cur.length; i++) {
      if (cur[i] > min[i] && (best < 0 || cur[i] - min[i] > cur[best] - min[best])) best = i
    }
    cur[best] -= 1
    excess -= 1
  }
  return cur.map((t, i) => (t === T(kept[i].durationSeconds) ? kept[i].durationSeconds : t / 10))
}

/** A continuing pair is kept whole or not at all. */
export function pairProblems(master: TvcPlan, kept: TvcShot[]): string[] {
  const out: string[] = []
  const has = new Set(kept.map((s) => s.n))
  for (const s of kept) {
    if (s.continuesFrom !== undefined && !has.has(s.continuesFrom)) out.push(`shot ${s.n} continues shot ${s.continuesFrom}; keep both or neither`)
    const next = master.shots.find((o) => o.continuesFrom === s.n)
    if (next && !has.has(next.n)) out.push(`shot ${next.n} continues shot ${s.n}; keep both or neither`)
  }
  return out
}

/** Everything that makes a kept set (in original numbering) unusable at this length. */
export function cutdownProblems(master: TvcPlan, kept: TvcShot[], durations: number[], lengthSeconds: number): string[] {
  const out = pairProblems(master, kept)
  for (let i = 1; i < kept.length; i++) {
    if (kept[i].continuesFrom === kept[i - 1].n) continue
    const cut = cutError(kept[i - 1], kept[i])
    if (cut) out.push(cut)
  }
  const starts: number[] = []
  let t = 0
  for (const d of durations) { starts.push(r1(t)); t += d }
  if (!kept.some((s, i) => s.brandVisible && starts[i] < BRAND_BY)) out.push('the brand must be on screen before 2.0s: keep a brandVisible shot at the start')
  if (lengthSeconds <= 15 && !kept.some((s, i) => s.productVisible && starts[i] <= PRODUCT_BY + EPS)) out.push('the product must appear by 3.0s: keep a productVisible shot near the start')
  return out
}

/** C2: the best set of the original's shots for this length, in order, the
 *  packshot last; null when none fits. Depth-first over every subset,
 *  including a shot before excluding it, pruned by length and by score. */
export function pickCutdownShots(master: TvcPlan, lengthSeconds: number): number[] | null {
  const pack = master.shots[master.shots.length - 1]
  const cands = master.shots.slice(0, -1)
  const target = T(lengthSeconds)
  const packDur = T(pack.durationSeconds), packMin = T(minCutdownSeconds(master, pack)), packScore = shotScore(pack)
  const minOf = cands.map((s) => T(minCutdownSeconds(master, s)))
  const durOf = cands.map((s) => T(s.durationSeconds))
  const scoreOf = cands.map(shotScore)
  const suffixScore = new Array<number>(cands.length + 1).fill(0)
  const suffixMaxDur = new Array<number>(cands.length + 1).fill(0)
  for (let i = cands.length - 1; i >= 0; i--) {
    suffixScore[i] = suffixScore[i + 1] + scoreOf[i]
    suffixMaxDur[i] = Math.max(suffixMaxDur[i + 1], durOf[i])
  }
  type Best = { keep: number[]; score: number; trim: number }
  for (let cap = CUTDOWN_MAX_SHOTS[lengthSeconds] ?? MAX_SHOTS; cap <= MAX_SHOTS; cap++) {
    let best = null as Best | null
    const chosen: number[] = []
    const visit = (i: number, minSum: number, durSum: number, score: number): void => {
      if (minSum + packMin > target) return
      const slots = cap - 1 - chosen.length
      if (durSum + slots * suffixMaxDur[i] + packDur < target) return
      if (best && score + suffixScore[i] + packScore < best.score) return
      if (i === cands.length) {
        const kept = [...chosen.map((k) => cands[k]), pack]
        const durations = fitDurations(master, kept, lengthSeconds)
        if (!durations || cutdownProblems(master, kept, durations, lengthSeconds).length) return
        const total = score + packScore, trim = durSum + packDur - target
        if (!best || total > best.score || (total === best.score && trim < best.trim)) best = { keep: kept.map((s) => s.n), score: total, trim }
        return
      }
      const s = cands[i]
      const last = chosen.length ? cands[chosen[chosen.length - 1]] : undefined
      const continuesLast = s.continuesFrom !== undefined && last?.n === s.continuesFrom
      // A 6s cut has no time for an on-camera line (8 words in all, and no voiceover over it).
      const lineTooLong = lengthSeconds <= 6 && s.audio === 'line'
      const canInclude = slots > 0 && !lineTooLong && (s.continuesFrom !== undefined ? continuesLast : !(last && cutError(last, s)))
      if (canInclude) {
        chosen.push(i)
        visit(i + 1, minSum + minOf[i], durSum + durOf[i], score + scoreOf[i])
        chosen.pop()
      }
      // A shot that continues a kept shot must be kept too.
      if (!continuesLast) visit(i + 1, minSum, durSum, score)
    }
    visit(0, 0, 0, 0)
    if (best) return best.keep
  }
  return null
}

/** D6: why this original can't be cut to this length, or null. */
export function cutdownRefusal(master: TvcPlan, lengthSeconds: number): string | null {
  if (master.cutdownOf) return 'CUTDOWN_OF_CUTDOWN: this ad is already a cutdown; make the shorter version from the original ad\'s plan'
  const len = master.brief.lengthSeconds
  const allowed = CUTDOWN_LENGTHS.filter((l) => l < len)
  if (allowed.length === 0) return `CUTDOWN_LENGTH: a ${len}s ad is already the shortest; it has no cutdown`
  if (!allowed.includes(lengthSeconds)) return `CUTDOWN_LENGTH: a cutdown of a ${len}s ad can be ${orList(allowed)} seconds`
  const missing = master.shots.filter((s) => !s.clipFileId).map((s) => s.n)
  if (missing.length) return `CUTDOWN_ORIGINAL_UNFINISHED: shots ${missing.join(', ')} of the original ad have no video yet; finish the original ad first`
  return null
}

const cutdownOfFor = (master: TvcPlan, planFileId: string): NonNullable<TvcPlan['cutdownOf']> => ({
  planFileId, ...(master.brief.reference?.cutTimes?.length ? { fromReference: true } : {}),
})

/** "6", "6 or 15", "6, 15 or 20". */
const orList = (ls: number[]): string => (ls.length === 1 ? `${ls[0]}` : `${ls.slice(0, -1).join(', ')} or ${ls[ls.length - 1]}`)

/** One kept shot: the original's picture, a new number, the fitted length,
 *  its source, the given text/motion/price, and the original clip only when
 *  the length is unchanged (otherwise it is re-trimmed at the finish). */
function cutdownShot(src: TvcShot, n: number, durationSeconds: number, renumber: Map<number, number>, words: Pick<TvcShot, 'text' | 'motion' | 'price'>): TvcShot {
  const shot: TvcShot = structuredClone(src)
  delete shot.stillFileId; delete shot.clipFileId; delete shot.text; delete shot.motion; delete shot.price; delete shot.continuesFrom; delete shot.source
  shot.n = n
  shot.durationSeconds = durationSeconds
  shot.source = { shot: src.n, clipFileId: src.clipFileId, seconds: src.durationSeconds }
  if (src.continuesFrom !== undefined) shot.continuesFrom = renumber.get(src.continuesFrom)
  if (words.text) shot.text = words.text
  if (words.motion) shot.motion = words.motion
  if (words.price) shot.price = structuredClone(words.price)
  if (durationSeconds === src.durationSeconds) shot.clipFileId = src.clipFileId
  return shot
}

function cutdownBrief(master: TvcPlan, lengthSeconds: number, keepJingle: boolean): TvcPlan['brief'] {
  const brief = structuredClone(master.brief)
  // The schema's refine narrows lengthSeconds to 6 | 15 | 20 | 30; cutdownRefusal
  // has already checked this length is one of them.
  brief.lengthSeconds = lengthSeconds as TvcPlan['brief']['lengthSeconds']
  delete brief.reference
  if (!keepJingle) delete brief.jingle
  return brief
}

export interface CutdownDraft { draft: TvcPlan; originalVoiceover: TvcPlan['voiceover'] }

/** C3: the draft cutdown plan_tvc cutdown returns (nothing is saved). */
export function draftCutdown(master: TvcPlan, masterPlanFileId: string, lengthSeconds: number, keepShots?: number[]): CutdownDraft | { error: string } {
  const refusal = cutdownRefusal(master, lengthSeconds)
  if (refusal) return { error: refusal }
  const pack = master.shots[master.shots.length - 1]
  // I3 (review): shots only shrink, and a cutdown has at most MAX_SHOTS shots,
  // so an original of short moments can't fill a long cutdown at all.
  const longest = master.shots.slice(0, -1).map((s) => s.durationSeconds).sort((a, b) => b - a).slice(0, MAX_SHOTS - 1)
  if (longest.reduce((t, d) => t + d, 0) + pack.durationSeconds < lengthSeconds - EPS) {
    const shorter = CUTDOWN_LENGTHS.filter((l) => l < lengthSeconds)
    return { error: `CUTDOWN_NO_FIT: the original's moments are too short to fill ${lengthSeconds}s in at most ${MAX_SHOTS} moments${shorter.length ? `; try ${orList(shorter)} seconds` : ''}` }
  }
  let keep: number[]
  if (keepShots && keepShots.length > 0) {
    const bad = keepShots.filter((n) => !master.shots.some((s) => s.n === n))
    if (bad.length) return { error: `CUTDOWN_NO_SUCH_SHOT: the original ad has no shot ${bad.join(', ')}` }
    keep = [...new Set([...keepShots, pack.n])].sort((a, b) => a - b)
  } else {
    const picked = pickCutdownShots(master, lengthSeconds)
    if (!picked) {
      return { error: `CUTDOWN_NO_FIT: no set of the original's shots makes a ${lengthSeconds}s ad that shows the brand in the first 2 seconds${lengthSeconds <= 15 ? ' and the product by 3 seconds' : ''} without two same-size shots in a row; choose the shots with keepShots` }
    }
    keep = picked
  }
  const kept = keep.map((n) => master.shots.find((s) => s.n === n)!)
  const durations = fitDurations(master, kept, lengthSeconds)
  if (!durations) {
    const total = r1(kept.reduce((t, s) => t + s.durationSeconds, 0))
    const least = r1(kept.reduce((t, s) => t + minCutdownSeconds(master, s), 0))
    return { error: `CUTDOWN_NO_FIT: shots ${keep.join(', ')} last ${total}s in the original and at least ${least}s when shortened; a ${lengthSeconds}s cutdown needs shots that fit exactly, so keep ${total < lengthSeconds ? 'more' : 'fewer'} shots` }
  }
  const problems = cutdownProblems(master, kept, durations, lengthSeconds)
  if (problems.length) return { error: `CUTDOWN_SHOTS: ${problems.join('; ')}` }
  const renumber = new Map(kept.map((s, i) => [s.n, i + 1]))
  // M5 (review): a claim shown on screen with no voiceover (e.g. an offer on a
  // price shot) moves with its shot: its new start is that shot's new start.
  // A claim whose shot was dropped gets no start, so check asks for one.
  const origStarts = shotStarts(master)
  const newStarts: number[] = []
  let at = 0
  for (const d of durations) { newStarts.push(r1(at)); at += d }
  const movedStart = (sec: number): number | undefined => {
    const i = kept.findIndex((s) => sec >= origStarts[s.n - 1] - EPS && sec < origStarts[s.n - 1] + s.durationSeconds - EPS)
    return i >= 0 ? newStarts[i] : undefined
  }
  const draft: TvcPlan = {
    brief: cutdownBrief(master, lengthSeconds, true),
    look: master.look,
    locations: structuredClone(master.locations),
    shots: kept.map((s, i) => cutdownShot(s, i + 1, durations[i], renumber, s)),
    voiceover: [],
    packshot: structuredClone(master.packshot),
    // D7: every claim's disclaimer is carried. A voiceover claim loses its start,
    // so the check refuses it (LEGAL_START_MISSING) until Director ties it to the
    // new script. The auto "Creative visualisation" line is re-added by check.
    legal: master.legal.filter((l) => !l.auto).map((l) => {
      const onScreen = l.forVoiceoverBlock === undefined && !l.wholeAd && l.startSeconds !== undefined ? movedStart(l.startSeconds) : undefined
      return {
        text: l.text, ...(l.wholeAd ? { wholeAd: true } : {}), ...(l.linkedWith ? { linkedWith: l.linkedWith } : {}),
        ...(onScreen !== undefined ? { startSeconds: onScreen } : {}),
      }
    }),
    ...(master.songFileId ? { songFileId: master.songFileId } : {}),
    cutdownOf: cutdownOfFor(master, masterPlanFileId),
  }
  return { draft, originalVoiceover: structuredClone(master.voiceover) }
}

/** C4: a Director-edited draft rebuilt from the original. Director chooses the
 *  shots (source.shot), their lengths, their words, the voiceover, the legal
 *  lines and the tagline; everything that is picture comes from the original. */
export function rebuildCutdown(input: TvcPlan, master: TvcPlan): { plan: TvcPlan } | { errors: string[] } {
  const length = input.brief.lengthSeconds
  const refusal = cutdownRefusal(master, length)
  if (refusal) return { errors: [refusal] }
  const noSource = input.shots.filter((s) => !s.source).map((s) => s.n)
  if (noSource.length) return { errors: [`CUTDOWN_SHOT_SOURCE_MISSING: shots ${noSource.join(', ')} have no source; start from plan_tvc cutdown's draft and keep each shot's source as given`] }
  const unknown = input.shots.map((s) => s.source!.shot).filter((n) => !master.shots.some((m) => m.n === n))
  if (unknown.length) return { errors: [`CUTDOWN_NO_SUCH_SHOT: the original ad has no shot ${unknown.join(', ')}`] }
  const kept = input.shots.map((s) => master.shots.find((m) => m.n === s.source!.shot)!)
  const errors: string[] = []
  if (kept.some((k, i) => i > 0 && k.n <= kept[i - 1].n)) errors.push('CUTDOWN_SHOTS: keep the shots in the original order, each once')
  if (kept[kept.length - 1].type !== 'packshot') errors.push('CUTDOWN_SHOTS: the original\'s packshot must be the last shot')
  errors.push(...pairProblems(master, kept).map((p) => `CUTDOWN_SHOTS: ${p}`))
  const keepJingle = !!input.brief.jingle && !!master.brief.jingle
  const durations = input.shots.map((s, i) => {
    const m = kept[i]
    const why = fixedLengthReason(master, m, keepJingle)
    const same = Math.abs(s.durationSeconds - m.durationSeconds) <= EPS
    if (why) {
      if (!same) errors.push(`CUTDOWN_SHOT_FIXED: shot ${s.n} (original shot ${m.n}) must stay ${m.durationSeconds}s because ${why}`)
      return m.durationSeconds
    }
    if (s.durationSeconds > m.durationSeconds + EPS) errors.push(`CUTDOWN_SHOT_TOO_LONG: shot ${s.n} (original shot ${m.n}) is ${s.durationSeconds}s; its clip is only ${m.durationSeconds}s`)
    return same ? m.durationSeconds : s.durationSeconds
  })
  if (errors.length) return { errors }
  const renumber = new Map(kept.map((m, i) => [m.n, i + 1]))
  const packshot = structuredClone(master.packshot)
  delete packshot.tagline; delete packshot.motion
  if (input.packshot.tagline !== undefined) packshot.tagline = input.packshot.tagline
  if (input.packshot.motion !== undefined) packshot.motion = input.packshot.motion
  return {
    plan: {
      brief: cutdownBrief(master, length, keepJingle),
      look: master.look,
      locations: structuredClone(master.locations),
      shots: input.shots.map((s, i) => cutdownShot(kept[i], i + 1, durations[i], renumber, s)),
      voiceover: structuredClone(input.voiceover),
      packshot,
      legal: structuredClone(input.legal),
      cutdownOf: cutdownOfFor(master, input.cutdownOf!.planFileId),
    },
  }
}

/** C4/D2/D4: fills what the plan still lacks from the original's recorded
 *  files: the bed always; the narration only when every block is an original
 *  block word for word in the same voice; the sung sign-off when it still fits. */
export function inheritFromMaster(plan: TvcPlan, master: TvcPlan): TvcPlan {
  const out = structuredClone(plan)
  if (!out.songFileId && master.songFileId) out.songFileId = master.songFileId
  if (!out.narrationFileIds && master.narrationFileIds && out.voiceover.length > 0 && out.brief.voiceId === master.brief.voiceId) {
    const ids = out.voiceover.map((v) => {
      const i = master.voiceover.findIndex((m) => m.text.trim() === v.text.trim())
      return i >= 0 ? master.narrationFileIds![i] : undefined
    })
    if (ids.every((id): id is string => !!id)) out.narrationFileIds = ids
  }
  if (out.brief.jingle && out.signoffSeconds === undefined && master.signoffSeconds !== undefined && master.jingleFileId && master.signoffFileId
    && jingleErrors(out, master.signoffSeconds).length === 0) {
    out.jingleFileId = master.jingleFileId
    out.signoffFileId = master.signoffFileId
    out.signoffSeconds = master.signoffSeconds
  }
  return out
}
