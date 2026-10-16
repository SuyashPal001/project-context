// How long to generate a clip and how to fit it to its shot: one rule for every video skill (the TVC
// solved it first; the remake had re-solved it by speeding clips up). Motion stays at real speed: a clip
// is generated at least as long as its shot and trimmed, and is sped up only when nobody would notice.

/** The most a clip may be sped up to fit its shot; above this it is trimmed instead. */
export const MAX_SPEEDUP = 1.15
/** A clip from a single start image opens with ~0.4s of near-stillness; it is trimmed off unless the
 *  shot continues the previous one (then it must start at 0). */
export const WARM_UP_S = 0.4
const MARGIN_S = 0.3

/** Seconds to generate for a shot. Free lengths: whole seconds, min-max. Fixed model lengths: the
 *  smallest that covers the shot, or undefined when none does. */
export function generateSeconds(shotSeconds: number, o: { continuing: boolean; lengths?: readonly number[]; warmUpS?: number; marginS?: number; min?: number; max?: number }): number | undefined {
  const need = shotSeconds + (o.continuing ? 0 : (o.warmUpS ?? WARM_UP_S)) + (o.marginS ?? MARGIN_S)
  if (o.lengths) return [...o.lengths].sort((a, b) => a - b).find((l) => l >= need - 1e-9)
  return Math.min(o.max ?? 10, Math.max(o.min ?? 3, Math.ceil(need - 1e-9)))
}

export type ClipFit = { mode: 'retime' } | { mode: 'trim'; startS: number }

/** Retime only a clip with no warm-up that is at most MAX_SPEEDUP longer than its shot (its last frame
 *  stays exact); otherwise cut the shot's length out at real speed, past any warm-up. */
export function clipFit(clipSeconds: number, shotSeconds: number, warmUpS: number): ClipFit {
  if (warmUpS === 0 && clipSeconds / shotSeconds <= MAX_SPEEDUP + 1e-9) return { mode: 'retime' }
  return { mode: 'trim', startS: Math.round(Math.min(warmUpS, Math.max(0, clipSeconds - shotSeconds)) * 100) / 100 }
}

/** A model with fixed lengths and an exact last frame (Veo first+last): the nearest length whose speed
 *  change can't be seen either way is retimed (the last frame stays exact); else the smallest that covers
 *  the shot, cut at real speed. Undefined when none covers it. */
export function pickLength(shotSeconds: number, lengths: readonly number[]): { seconds: number; fit: ClipFit } | undefined {
  const near = [...lengths].filter((l) => Math.max(l / shotSeconds, shotSeconds / l) <= MAX_SPEEDUP + 1e-9).sort((a, b) => Math.abs(a - shotSeconds) - Math.abs(b - shotSeconds))[0]
  if (near !== undefined) return { seconds: near, fit: { mode: 'retime' } }
  const cover = generateSeconds(shotSeconds, { continuing: true, lengths, marginS: 0 })
  return cover === undefined ? undefined : { seconds: cover, fit: clipFit(cover, shotSeconds, 0) }
}
