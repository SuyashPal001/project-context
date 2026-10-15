import { existsSync } from 'node:fs'
import { createScorer } from '@mastra/core/evals'

// Deterministic golden-set scorers (spec §8a): grade every prompt or model
// change against videos whose right answers were measured by hand.
type Out = { cuts?: { cuts: number[] } | null; hidden_cuts: Array<{ at_s: number }>; overview: { moments: Array<{ t_s: number; measured?: boolean }>; looks: Array<{ leg_side?: string }> } }
const gt = (run: { groundTruth?: unknown }) => (run.groundTruth ?? {}) as Record<string, any>

export const goldenCutsScorer = createScorer({ id: 'golden-cuts', name: 'golden-cuts', description: 'Hard-cut count within 15% of the measured truth' })
  .generateScore(({ run }) => { const c = (run.output as Out).cuts; if (!c) return 0; const t = gt(run).cutCount as number; return Math.abs(c.cuts.length - t) <= (t === 0 ? 0 : Math.max(1, 0.15 * t)) ? 1 : 0 })
export const goldenHiddenCutsScorer = createScorer({ id: 'golden-hidden-cuts', name: 'golden-hidden-cuts', description: 'Hidden cuts: same count, each within 0.4s' })
  .generateScore(({ run }) => { const got = (run.output as Out).hidden_cuts.map((h) => h.at_s).sort((a, b) => a - b); const want = gt(run).hiddenCuts as number[]; return got.length === want.length && want.every((w, i) => Math.abs(got[i] - w) <= 0.4) ? 1 : 0 })
export const goldenMomentsScorer = createScorer({ id: 'golden-moments', name: 'golden-moments', description: 'Fraction of truth moments matched by a MEASURED moment within 0.5s' })
  .generateScore(({ run }) => { const ms = (run.output as Out).overview.moments.filter((m) => m.measured); const want = gt(run).moments as Array<{ t_s: number }>; return want.length ? want.filter((w) => ms.some((m) => Math.abs(m.t_s - w.t_s) <= 0.5)).length / want.length : 1 })
export const goldenLegsScorer = createScorer({ id: 'golden-legs', name: 'golden-legs', description: 'Fraction of looks with the right leg side' })
  .generateScore(({ run }) => { const looks = (run.output as Out).overview.looks; const want = gt(run).legSides as string[]; return want.length ? want.filter((w, i) => looks[i]?.leg_side === w).length / want.length : 1 })

export function missingFixtures(items: Array<{ input: { filePath: string } }>): string[] {
  return items.map((i) => i.input.filePath).filter((p) => !existsSync(p))
}

export function itemsWithTruth<T extends { groundTruth?: Record<string, unknown> }>(items: T[], key: string): T[] {
  return items.filter((i) => Array.isArray(i.groundTruth?.[key]) && (i.groundTruth![key] as unknown[]).length > 0)
}
