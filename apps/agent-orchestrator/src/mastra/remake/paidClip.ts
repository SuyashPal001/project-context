// One paid clip, money-safe (spec §8a, rule 11): gate before every paid call; Veo refused →
// one Omni attempt from the start still; trim to exact frames; check; one retry; ledger.
import { join } from 'node:path'
import type { MediaExecContext } from '../tools/batchRunner.js'
import type { Img } from '../tools/tvcChecks.js'
import type { CheckResult } from '../scorers/video/gate.js'
import type { RemakeDeps } from './deps.js'
import { clipPrompt, clipGateInput, type ClipSpec } from './clipSpec.js'
import type { Brand, LedgerEntry, RemakePlan } from './types.js'

// One charge-key slot per (look, attempt, variant); all above the still slots (< 1000).
const VARIANT = { normal: 0, plain: 1, fallback: 2 } as const
export type ClipVariant = keyof typeof VARIANT
export const clipSlot = (n: number, attempt: number, variant: ClipVariant): number => 1000 + n * 8 + attempt * 3 + VARIANT[variant]

export interface ClipResult { look: number; fileId: string | null; localPath: string | null; engine: 'veo' | 'omni' | 'none'; fallback: boolean; status: 'passed' | 'failed' | 'unchecked' | 'blocked' | 'still'; reasons: string[]; failedChecks?: boolean }
export interface ClipCtx {
  tenantId: string; idToken: string; scopeId: string; runId: string
  exec: (slot: number) => MediaExecContext
  portrait: Img | null; plan: RemakePlan; brand: Brand
  size: { width: number; height: number }; workDir: string
  check: (clipPath: string, spec: ClipSpec, engine: 'veo' | 'omni') => Promise<CheckResult>
}

const aspect = (s: { width: number; height: number }): '9:16' | '16:9' => (s.height >= s.width ? '9:16' : '16:9')

export async function makeClip(spec: ClipSpec, ctx: ClipCtx, deps: RemakeDeps, ledger: LedgerEntry[] = []): Promise<{ result: ClipResult; ledger: LedgerEntry[] }> {
  // `ledger` is owned by the caller: every paid attempt is recorded the moment it is paid, so a
  // throw later in this function can never make a paid attempt disappear from the cost meter.
  const n = spec.look.n
  const item = `look ${n} clip`
  let engine: 'veo' | 'omni' = spec.engine === 'veo' ? 'veo' : 'omni'
  let fallback = false
  const base = () => ({ look: n, engine: spec.engine === 'none' ? 'none' as const : engine, fallback })
  if (spec.engine === 'none' || !spec.start) return { result: { ...base(), fileId: null, localPath: null, status: 'still', reasons: [spec.reason ?? 'this part stays a still'] }, ledger }

  const promptFor = (e: 'veo' | 'omni', plain = false) => clipPrompt(ctx.plan, spec.look, ctx.brand, e, spec.seconds, plain)
  let prompt = promptFor(engine)
  let last: { fileId: string; localPath: string; reasons: string[] } | null = null
  let triedPlain = false
  // failedChecks: true only when the clip exists but didn't pass its checks (vs never made).
  const failedResult = (reasons: string[], fileId: string | null = null) => ({ result: last ? { ...base(), fileId: last.fileId, localPath: last.localPath, status: 'failed' as const, reasons: last.reasons, failedChecks: true } : { ...base(), fileId, localPath: null, status: 'failed' as const, reasons, failedChecks: false }, ledger })
  const gate = async (p: string) => {
    const g = await deps.promptGate({ ...clipGateInput(ctx.plan, spec.look, p), tenantId: ctx.tenantId })
    if (g.status === 'unknown') console.error(`[remake] ${item} prompt check unavailable: ${g.reason}`)
    return g.status === 'pass' ? null : (g.status === 'unknown' ? 'the clip couldn’t be checked before making it, so it wasn’t made' : g.reason)
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const blocked = await gate(prompt)
    if (blocked) {
      ledger.push({ item, attempt, creditsMicro: '0', outcome: 'blocked' })
      return last ? failedResult(last.reasons) : { result: { ...base(), fileId: null, localPath: null, status: 'blocked', reasons: [blocked] }, ledger }
    }
    const title = `Remake look ${n} clip`
    const call = (e: 'veo' | 'omni', p: string, variant: ClipVariant) => (e === 'veo'
      ? deps.generateVeoClip({ prompt: p, startImageFileId: spec.start!, endImageFileId: spec.end ?? undefined, durationSeconds: spec.seconds as 4 | 6 | 8, aspectRatio: aspect(ctx.size), title }, ctx.exec(clipSlot(n, attempt, variant)), clipSlot(n, attempt, variant))
      : deps.generateOmniClip({ prompt: p, startImageFileId: spec.start!, durationSeconds: spec.seconds, aspectRatio: aspect(ctx.size), title }, ctx.exec(clipSlot(n, attempt, variant)), clipSlot(n, attempt, variant)))
    const blockedByVeo = (r: { fileId?: string; refusalReason?: string }) => engine === 'veo' && !r.fileId && r.refusalReason === 'CONTENT_BLOCKED'
    let g = await call(engine, prompt, fallback ? 'fallback' : 'normal')
    // The person may read as under 18: rewording or another model won't help (free: blocked clips are
    // not charged); the user needs an older-looking person (metro lip-sync test, 2026-10-16).
    if (!g.fileId && g.refusalReason === 'MINOR_BLOCKED') {
      ledger.push({ item, attempt, creditsMicro: '0', outcome: 'blocked' })
      return { result: { ...base(), fileId: null, localPath: null, status: 'blocked', reasons: ['the person looks too young for video to be made of them; pick an older-looking person and try again'] }, ledger }
    }
    // Spec rule 11: a content block is retried once with plainer wording (free: blocked clips
    // are not charged), then once with the other model from the start still.
    if (blockedByVeo(g) && !fallback && !triedPlain) {
      ledger.push({ item, attempt, creditsMicro: '0', outcome: 'retried' })
      triedPlain = true
      const plain = promptFor('veo', true)
      const blockedPlain = await gate(plain)
      if (!blockedPlain) { prompt = plain; g = await call('veo', plain, 'plain') }
    }
    if (blockedByVeo(g) && !fallback) {
      ledger.push({ item, attempt, creditsMicro: '0', outcome: 'retried' })
      engine = 'omni'; fallback = true
      prompt = promptFor('omni')
      const again = await gate(prompt)
      if (again) {
        ledger.push({ item, attempt, creditsMicro: '0', outcome: 'blocked' })
        return { result: { ...base(), fileId: null, localPath: null, status: 'blocked', reasons: [again] }, ledger }
      }
      g = await call('omni', prompt, 'fallback')
    }
    const spent = g.creditsUsedMicro ?? '0'
    if (!g.fileId) {
      if (!g.insufficientCredits) console.error(`[remake] ${item} not made: ${g.refusalReason ?? 'unknown'}`)
      ledger.push({ item, attempt, creditsMicro: spent, outcome: 'failed' })
      return failedResult([g.insufficientCredits ? 'not enough credits' : 'the clip could not be made'])
    }
    // Paid from here on: record it now (outcome settled below), then guard every step after.
    const entry: LedgerEntry = { item, attempt, creditsMicro: spent, outcome: 'failed' }
    ledger.push(entry)
    let trimmed: string, c: Awaited<ReturnType<ClipCtx['check']>>
    try {
      const local = await deps.localFile(g.fileId, ctx.idToken, ctx.scopeId)
      trimmed = await deps.fitToFrames(local, spec.frames, join(ctx.workDir, `look-${n}-a${attempt}.mp4`), ctx.size)
      c = await ctx.check(trimmed, spec, engine)
    } catch (err) {
      console.error(`[remake] ${item} could not be prepared:`, err instanceof Error ? err.message : String(err))
      return failedResult(['the clip could not be prepared this time'], g.fileId)
    }
    if (c.status !== 'fail') {
      entry.outcome = 'kept'
      return { result: { ...base(), fileId: g.fileId, localPath: trimmed, status: c.status === 'pass' ? 'passed' : 'unchecked', reasons: c.status === 'pass' ? [] : [c.reason] }, ledger }
    }
    entry.outcome = attempt === 0 ? 'retried' : 'failed'
    last = { fileId: g.fileId, localPath: trimmed, reasons: [c.reason] }
    prompt = `${promptFor(engine, triedPlain && engine === 'veo')} Fix: ${c.reason}`
  }
  return failedResult(last!.reasons)
}
