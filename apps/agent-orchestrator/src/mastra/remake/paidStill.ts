// One paid still, money-safe (spec §8a): the prompt is gated BEFORE every paid call
// (including the retry), the still is checked after, one automatic retry with the
// reasons added, and every attempt goes in the ledger.
import type { MediaExecContext } from '../tools/batchRunner.js'
import type { Img } from '../tools/tvcChecks.js'
import type { CheckResult } from '../scorers/video/gate.js'
import type { RemakeDeps } from './deps.js'
import { comparePose } from './poseCompare.js'
import { personIn } from './looks.js'
import type { stillGateInput } from './prompts.js'
import type { LedgerEntry, RemakeLook, StillResult } from './types.js'

export interface StillCtx {
  tenantId: string; idToken: string; scopeId: string; runId: string
  exec: (slot: number) => MediaExecContext
  portrait: { fileId: string; img: Img } | null
}
export interface StillJob { look: RemakeLook; kind: 'start' | 'end'; prompt: string; references: string[]; aspectRatio: '9:16' | '16:9' | '1:1'; gate: ReturnType<typeof stillGateInput> }

export const slotFor = (n: number, kind: 'start' | 'end', attempt: number): number => n * 4 + (kind === 'end' ? 2 : 0) + attempt

async function checkStill(fileId: string, job: StillJob, ctx: StillCtx, deps: RemakeDeps): Promise<CheckResult> {
  try {
    const still = await deps.fetchImage(fileId, ctx.idToken)
    const person = personIn(job.look)
    const [looks, pose] = await Promise.all([
      deps.stillChecks(deps.ask(ctx.tenantId), still, { lead: ctx.portrait?.img, leadInShot: person && !!ctx.portrait }),
      deps.localFile(fileId, ctx.idToken, ctx.scopeId).then((p) => deps.poseImage(p)),
    ])
    const body = job.kind === 'start' ? job.look.start : job.look.end
    const p = comparePose(body, job.look.people, pose)
    const reasons = [...looks.reasons, ...(p.status === 'fail' ? [p.reason] : [])]
    if (reasons.length) return { name: 'still', status: 'fail', reason: reasons.join('; '), evidenceTimes: [] }
    if (p.status === 'unknown') return { name: 'still', status: 'unknown', reason: p.reason, evidenceTimes: [] }
    return { name: 'still', status: 'pass', reason: 'passed every check', evidenceTimes: [] }
  } catch (err) {
    console.error('[remake] still check failed:', err instanceof Error ? err.message : String(err))
    return { name: 'still', status: 'unknown', reason: 'the still could not be checked this time', evidenceTimes: [] }
  }
}

export async function makeStill(job: StillJob, ctx: StillCtx, deps: RemakeDeps): Promise<{ result: StillResult; ledger: LedgerEntry[] }> {
  const item = `look ${job.look.n} ${job.kind} still`
  const base = { look: job.look.n, kind: job.kind }
  const ledger: LedgerEntry[] = []
  let prompt = job.prompt
  let last: { fileId: string; reasons: string[] } | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const gate = await deps.promptGate({ ...job.gate, prompt, tenantId: ctx.tenantId })
    if (gate.status !== 'pass') {
      ledger.push({ item, attempt, creditsMicro: '0', outcome: 'blocked' })
      return last
        ? { result: { ...base, fileId: last.fileId, status: 'failed', reasons: last.reasons }, ledger }
        : { result: { ...base, fileId: null, status: 'blocked', reasons: [gate.reason] }, ledger }
    }
    const slot = slotFor(job.look.n, job.kind, attempt)
    const g = await deps.generateStill(
      { prompt, aspectRatio: job.aspectRatio, referenceFileIds: job.references, engine: 'gemini', title: `Remake look ${job.look.n} ${job.kind} still` },
      ctx.exec(slot), slot)
    const spent = g.creditsUsedMicro ?? '0'
    if (!g.fileId) {
      if (!g.insufficientCredits) console.error(`[remake] ${item} not made: ${g.refusalReason ?? 'unknown'}`)
      ledger.push({ item, attempt, creditsMicro: spent, outcome: 'failed' })
      return { result: { ...base, fileId: last?.fileId ?? null, status: 'failed', reasons: [g.insufficientCredits ? 'not enough credits' : 'the image could not be made'] }, ledger }
    }
    const c = await checkStill(g.fileId, job, ctx, deps)
    if (c.status === 'pass' || c.status === 'unknown') {
      ledger.push({ item, attempt, creditsMicro: spent, outcome: 'kept' })
      return { result: { ...base, fileId: g.fileId, status: c.status === 'pass' ? 'passed' : 'unchecked', reasons: c.status === 'pass' ? [] : [c.reason] }, ledger }
    }
    ledger.push({ item, attempt, creditsMicro: spent, outcome: attempt === 0 ? 'retried' : 'failed' })
    last = { fileId: g.fileId, reasons: [c.reason] }
    prompt = `${job.prompt} Fix: ${c.reason}`
  }
  return { result: { ...base, fileId: last!.fileId, status: 'failed', reasons: last!.reasons }, ledger }
}
