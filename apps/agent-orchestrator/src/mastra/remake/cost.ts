import type { LedgerEntry, RemakePlan } from './types.js'
import type { ClipSpec } from './clipSpec.js'

export function estimateCost(plan: RemakePlan, opts: { castProvided: boolean; microEach: bigint | null }) {
  const sheet = plan.needsCasting && !opts.castProvided ? 1 : 0
  const stills = plan.looks.reduce((n, l) => n + 1 + (l.needsEndStill ? 1 : 0), 0)
  const each = opts.microEach
  return {
    images: sheet + stills,
    firstPassMicro: each === null ? null : String(each * BigInt(sheet + stills)),
    maxMicro: each === null ? null : String(each * BigInt(sheet + stills * 2)),
  }
}

export function ledgerSummary(entries: LedgerEntry[]) {
  const sum = (xs: LedgerEntry[]) => String(xs.reduce((n, e) => n + BigInt(e.creditsMicro || '0'), 0n))
  return {
    spentMicro: sum(entries),
    wastedMicro: sum(entries.filter((e) => e.outcome === 'retried' || e.outcome === 'failed')),
    failed: [...new Set(entries.filter((e) => e.outcome === 'failed').map((e) => e.item))],
    blocked: [...new Set(entries.filter((e) => e.outcome === 'blocked').map((e) => e.item))],
  }
}

export const credits = (micro: string | null): string => (micro === null ? 'unknown' : (Number(BigInt(micro)) / 1e6).toFixed(2))

/** Clips + music, shown at the preview before any clip is paid. Max allows one retry per clip,
 *  and for a Veo clip the Omni fallback and its retry (Veo + 2 × Omni). Null when a rate is missing. */
export function estimateClipsCost(specs: ClipSpec[], r: { veo: bigint | null; omni: bigint | null; music: bigint | null }) {
  const live = specs.filter((s) => s.engine !== 'none')
  const needVeo = live.some((s) => s.engine === 'veo')
  if (r.omni === null || r.music === null || (needVeo && r.veo === null)) return { clips: live.length, firstPassMicro: null, maxMicro: null }
  const first = live.reduce((t, s) => t + (s.engine === 'veo' ? r.veo! : r.omni!), 0n) + r.music
  const max = live.reduce((t, s) => t + (s.engine === 'veo' ? r.veo! + 2n * r.omni! : 2n * r.omni!), 0n) + r.music
  return { clips: live.length, firstPassMicro: String(first), maxMicro: String(max) }
}
