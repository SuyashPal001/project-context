import type { LedgerEntry, RemakePlan } from './types.js'

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
