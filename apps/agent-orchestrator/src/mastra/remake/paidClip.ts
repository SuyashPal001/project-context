// One paid clip, money-safe (spec §8a, rule 11): gate before every paid call; Veo refused →
// one Omni attempt from the start still; trim to exact frames; check; one retry; ledger.
import { join } from 'node:path'
import type { MediaExecContext } from '../tools/batchRunner.js'
import type { Img } from '../tools/tvcChecks.js'
import type { CheckResult } from '../scorers/video/gate.js'
import type { RemakeDeps } from './deps.js'
import { clipPrompt, clipGateInput, type ClipSpec } from './clipSpec.js'
import type { Brand, LedgerEntry, RemakePlan } from './types.js'

export const clipSlot = (n: number, attempt: number, fallback: boolean): number => 1000 + n * 8 + attempt * 2 + (fallback ? 1 : 0)

export interface ClipResult { look: number; fileId: string | null; localPath: string | null; engine: 'veo' | 'omni' | 'none'; fallback: boolean; status: 'passed' | 'failed' | 'unchecked' | 'blocked' | 'still'; reasons: string[] }
export interface ClipCtx {
  tenantId: string; idToken: string; scopeId: string; runId: string
  exec: (slot: number) => MediaExecContext
  portrait: Img | null; plan: RemakePlan; brand: Brand
  size: { width: number; height: number }; workDir: string
  check: (clipPath: string, spec: ClipSpec) => Promise<CheckResult>
}

const aspect = (s: { width: number; height: number }): '9:16' | '16:9' => (s.height >= s.width ? '9:16' : '16:9')

export async function makeClip(spec: ClipSpec, ctx: ClipCtx, deps: RemakeDeps): Promise<{ result: ClipResult; ledger: LedgerEntry[] }> {
  const n = spec.look.n
  const item = `look ${n} clip`
  const ledger: LedgerEntry[] = []
  let engine: 'veo' | 'omni' = spec.engine === 'veo' ? 'veo' : 'omni'
  let fallback = false
  const base = () => ({ look: n, engine: spec.engine === 'none' ? 'none' as const : engine, fallback })
  if (spec.engine === 'none' || !spec.start) return { result: { ...base(), fileId: null, localPath: null, status: 'still', reasons: [spec.reason ?? 'this part stays a still'] }, ledger }

  let prompt = clipPrompt(ctx.plan, spec.look, ctx.brand, engine)
  let last: { fileId: string; localPath: string; reasons: string[] } | null = null
  const gate = async (p: string) => {
    const g = await deps.promptGate({ ...clipGateInput(ctx.plan, spec.look, p), tenantId: ctx.tenantId })
    if (g.status === 'unknown') console.error(`[remake] ${item} prompt check unavailable: ${g.reason}`)
    return g.status === 'pass' ? null : (g.status === 'unknown' ? 'the clip couldn’t be checked before making it, so it wasn’t made' : g.reason)
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const blocked = await gate(prompt)
    if (blocked) {
      ledger.push({ item, attempt, creditsMicro: '0', outcome: 'blocked' })
      return { result: last ? { ...base(), fileId: last.fileId, localPath: last.localPath, status: 'failed', reasons: last.reasons } : { ...base(), fileId: null, localPath: null, status: 'blocked', reasons: [blocked] }, ledger }
    }
    const title = `Remake look ${n} clip`
    const call = (e: 'veo' | 'omni', p: string) => (e === 'veo'
      ? deps.generateVeoClip({ prompt: p, startImageFileId: spec.start!, endImageFileId: spec.end ?? undefined, durationSeconds: spec.seconds as 4 | 6 | 8, aspectRatio: aspect(ctx.size), title }, ctx.exec(clipSlot(n, attempt, fallback)), clipSlot(n, attempt, fallback))
      : deps.generateOmniClip({ prompt: p, startImageFileId: spec.start!, durationSeconds: spec.seconds, aspectRatio: aspect(ctx.size), title }, ctx.exec(clipSlot(n, attempt, fallback)), clipSlot(n, attempt, fallback)))
    let g = await call(engine, prompt)
    if (engine === 'veo' && !g.fileId && g.refusalReason === 'CONTENT_BLOCKED' && !fallback) {
      ledger.push({ item, attempt, creditsMicro: '0', outcome: 'retried' })
      engine = 'omni'; fallback = true
      prompt = clipPrompt(ctx.plan, spec.look, ctx.brand, 'omni')
      const again = await gate(prompt)
      if (again) {
        ledger.push({ item, attempt, creditsMicro: '0', outcome: 'blocked' })
        return { result: { ...base(), fileId: null, localPath: null, status: 'blocked', reasons: [again] }, ledger }
      }
      g = await call('omni', prompt)
    }
    const spent = g.creditsUsedMicro ?? '0'
    if (!g.fileId) {
      if (!g.insufficientCredits) console.error(`[remake] ${item} not made: ${g.refusalReason ?? 'unknown'}`)
      ledger.push({ item, attempt, creditsMicro: spent, outcome: 'failed' })
      return { result: { ...base(), fileId: last?.fileId ?? null, localPath: last?.localPath ?? null, status: 'failed', reasons: [g.insufficientCredits ? 'not enough credits' : 'the clip could not be made'] }, ledger }
    }
    const local = await deps.localFile(g.fileId, ctx.idToken, ctx.scopeId)
    const trimmed = await deps.trimToFrames(local, spec.frames, join(ctx.workDir, `look-${n}-a${attempt}.mp4`), ctx.size)
    const c = await ctx.check(trimmed, spec)
    if (c.status !== 'fail') {
      ledger.push({ item, attempt, creditsMicro: spent, outcome: 'kept' })
      return { result: { ...base(), fileId: g.fileId, localPath: trimmed, status: c.status === 'pass' ? 'passed' : 'unchecked', reasons: c.status === 'pass' ? [] : [c.reason] }, ledger }
    }
    ledger.push({ item, attempt, creditsMicro: spent, outcome: attempt === 0 ? 'retried' : 'failed' })
    last = { fileId: g.fileId, localPath: trimmed, reasons: [c.reason] }
    prompt = `${clipPrompt(ctx.plan, spec.look, ctx.brand, engine)} Fix: ${c.reason}`
  }
  return { result: { ...base(), fileId: last!.fileId, localPath: last!.localPath, status: 'failed', reasons: last!.reasons }, ledger }
}
