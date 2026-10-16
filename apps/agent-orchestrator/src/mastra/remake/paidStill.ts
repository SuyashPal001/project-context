// One paid still, money-safe (spec §8a): the prompt is gated BEFORE every paid call
// (including the retry), the still is checked after, one automatic retry with the
// reasons added, and every attempt goes in the ledger.
import type { MediaExecContext } from '../tools/batchRunner.js'
import type { Img } from '../tools/tvcChecks.js'
import type { CheckResult } from '../scorers/video/gate.js'
import type { RemakeDeps } from './deps.js'
import { comparePose } from './poseCompare.js'
import { cropFramingFor } from './tightShots.js'
import { personIn } from './looks.js'
import type { stillGateInput } from './prompts.js'
import type { LedgerEntry, RemakeLook, StillResult, StillTry } from './types.js'

export interface StillCtx {
  tenantId: string; idToken: string; scopeId: string; runId: string
  conversationId?: string
  exec: (slot: number) => MediaExecContext
  portrait: { fileId: string; img: Img } | null
  /** True once the run has run out of credits: checked right before each paid call. */
  outOfCredits?: () => boolean
}
export interface StillJob { look: RemakeLook; kind: 'start' | 'end'; prompt: string; references: string[]; aspectRatio: '9:16' | '16:9' | '1:1'; gate: ReturnType<typeof stillGateInput> }

export const slotFor = (n: number, kind: 'start' | 'end', attempt: number): number => n * 4 + (kind === 'end' ? 2 : 0) + attempt

// hard: one paid retry. warnings: the still is kept and the user sees what may be off (user's call).
// fileId: set when the still was cropped to a tighter original (the crop is what is kept).
type StillCheck = { status: CheckResult['status']; hard: string[]; warnings: string[]; reason: string; fileId?: string }

// A retry asks for the fix in plain plan words. The check's own description ("rounder face,
// different nose") read to the prompt check as invented content and blocked the retry (fan rerun).
const FIXES: Array<[RegExp, string]> = [
  [/face differs/i, 'the face must be exactly the person in the first image'],
  [/appears twice/i, 'show each object only once'],
  [/extra person|only \d+ person/i, 'exactly as many people as the second image shows'],
  [/no person found/i, 'the person is in the shot as in the second image'],
  [/appears where the reference has none/i, 'no person in this image'],
  [/looks like the lead/i, 'no one else looks like the person in the first image'],
  [/back to the camera|facing the camera|side-on/i, 'the person faces the camera exactly as in the second image'],
]
const NEEDS_FRESH = /back to the camera|facing the camera|side-on|no person found|appears where the reference has none/i
export const editPrompt = (fix: string): string =>
  `Edit the first image. Change only this: ${fix}. Keep everything else exactly: the pose, framing, setting, outfit, objects and light. No text or logos.`

export function fixLine(reasons: string[]): string {
  return [...new Set(reasons.map((r) => FIXES.find(([re]) => re.test(r))?.[1] ?? r))].join('; ')
}

async function checkStill(fileId: string, job: StillJob, ctx: StillCtx, deps: RemakeDeps): Promise<StillCheck> {
  try {
    const still = await deps.fetchImage(fileId, ctx.idToken)
    const person = personIn(job.look)
    const [looks, pose] = await Promise.all([
      // No face check when the original shows the person from the back: there is no face to compare.
      deps.stillChecks(deps.ask(ctx.tenantId), still, { lead: ctx.portrait?.img, leadInShot: person && !!ctx.portrait && (job.kind === 'start' ? job.look.start : job.look.end)?.facing !== 'back' }),
      deps.localFile(fileId, ctx.idToken, ctx.scopeId).then((p) => deps.poseImage(p)),
    ])
    const body = job.kind === 'start' ? job.look.start : job.look.end
    let p = comparePose(body, job.look.people, pose)
    // A tighter original (selfie, close-up): crop the still around the face, free, and keep the crop
    // when it matches. A crop that can't be made keeps the still with its framing warning.
    let cropped: string | undefined
    const crop = body && pose.main ? cropFramingFor(body.framing, pose.main.framing) : null
    if (crop && p.status !== 'pass' && !p.hard && deps.cropStill) {
      try {
        const id = await deps.cropStill(fileId, crop, job.aspectRatio, ctx)
        const q = comparePose(body, job.look.people, await deps.poseImage(await deps.localFile(id, ctx.idToken, ctx.scopeId)))
        if (q.status !== 'fail') { p = q; cropped = id }
      } catch (err) {
        console.error('[remake] crop to the original framing failed:', err instanceof Error ? err.message : String(err))
      }
    }
    const hard = [...looks.reasons, ...(p.status === 'fail' && p.hard ? [p.reason] : [])]
    const warnings = [...(looks.warnings ?? []), ...(p.status === 'fail' && !p.hard ? [p.reason] : [])]
    if (hard.length) return { status: 'fail', hard, warnings, reason: hard.join('; ') }
    if (p.status === 'unknown' && !warnings.length) return { status: 'unknown', hard, warnings, reason: p.reason, fileId: cropped }
    return { status: 'pass', hard, warnings, reason: warnings.join('; ') || 'passed every check', fileId: cropped }
  } catch (err) {
    console.error('[remake] still check failed:', err instanceof Error ? err.message : String(err))
    return { status: 'unknown', hard: [], warnings: [], reason: 'the still could not be checked this time' }
  }
}

export async function makeStill(job: StillJob, ctx: StillCtx, deps: RemakeDeps): Promise<{ result: StillResult; ledger: LedgerEntry[] }> {
  const item = `look ${job.look.n} ${job.kind} still`
  const base = { look: job.look.n, kind: job.kind }
  const ledger: LedgerEntry[] = []
  let prompt = job.prompt
  let references = job.references
  let retryNote = ''
  let last: { fileId: string; reasons: string[] } | null = null
  const tries: StillTry[] = []
  const withTries = (r: { result: StillResult; ledger: LedgerEntry[] }) => (tries.length ? { ...r, result: { ...r.result, tries } } : r)
  for (let attempt = 0; attempt < 2; attempt++) {
    const gate = await deps.promptGate({ ...job.gate, prompt, tenantId: ctx.tenantId, ...(attempt > 0 ? { planLine: `${job.gate.planLine}; ${retryNote}` } : {}) })
    if (gate.status !== 'pass') {
      // A blocked retry after a failed attempt: the item failed (the paid attempt was wasted),
      // so the ledger says failed too, never "blocked" next to a failed result (M6).
      if (last) ledger[ledger.length - 1].outcome = 'failed'
      else ledger.push({ item, attempt, creditsMicro: '0', outcome: 'blocked' })
      // An unknown gate is an outage: log the raw reason, tell the user plain words (no internals).
      if (gate.status === 'unknown') console.error(`[remake] ${item} prompt check unavailable: ${gate.reason}`)
      const why = gate.status === 'unknown' ? 'the still couldn’t be checked before making it, so it wasn’t made' : gate.reason
      return withTries(last
        ? { result: { ...base, fileId: last.fileId, status: 'failed', reasons: last.reasons }, ledger }
        : { result: { ...base, fileId: null, status: 'blocked', reasons: [why] }, ledger })
    }
    if (ctx.outOfCredits?.()) {
      if (last) ledger[ledger.length - 1].outcome = 'failed'
      return withTries({ result: { ...base, fileId: last?.fileId ?? null, status: 'failed', reasons: last ? [...last.reasons, 'no second try: not enough credits'] : ['not enough credits'] }, ledger })
    }
    const slot = slotFor(job.look.n, job.kind, attempt)
    // skipAvatarExpansion: images are placed by role (portrait, then pose guide); an avatar's
    // reference sheet would push the guide out of second place and change the gated prompt.
    const g = await deps.generateStill(
      { prompt, aspectRatio: job.aspectRatio, referenceFileIds: references, engine: 'gemini', skipAvatarExpansion: true, title: `Remake look ${job.look.n} ${job.kind} still` },
      ctx.exec(slot), slot)
    const spent = g.creditsUsedMicro ?? '0'
    if (!g.fileId) {
      if (!g.insufficientCredits) console.error(`[remake] ${item} not made: ${g.refusalReason ?? 'unknown'}`)
      ledger.push({ item, attempt, creditsMicro: spent, outcome: 'failed' })
      const why = g.insufficientCredits ? 'not enough credits' : 'the image could not be made'
      // A retry that couldn't be made keeps the first try's reason (M9).
      return withTries({ result: { ...base, fileId: last?.fileId ?? null, status: 'failed', reasons: last ? [...last.reasons, `no second try: ${why}`] : [why] }, ledger })
    }
    const c = await checkStill(g.fileId, job, ctx, deps)
    if (c.status === 'pass' || c.status === 'unknown') {
      ledger.push({ item, attempt, creditsMicro: spent, outcome: 'kept' })
      const status = c.status === 'unknown' ? 'unchecked' : c.warnings.length ? 'warned' : 'passed'
      const kept = c.fileId ?? g.fileId
      tries.push({ fileId: kept, kept: true, why: status === 'passed' ? [] : status === 'warned' ? c.warnings : [c.reason], creditsMicro: spent })
      return withTries({ result: { ...base, fileId: kept, status, reasons: status === 'passed' ? [] : status === 'warned' ? c.warnings : [c.reason] }, ledger })
    }
    ledger.push({ item, attempt, creditsMicro: spent, outcome: attempt === 0 ? 'retried' : 'failed' })
    last = { fileId: g.fileId, reasons: [c.reason] }
    tries.push({ fileId: g.fileId, kept: false, why: c.hard, creditsMicro: spent })
    // Edit, never regenerate (user rule): a wrong face, a lookalike or a duplicate object is fixed by
    // editing the failed still (it first, the chosen person second), so the pose and scene that
    // passed are kept. Only a wrong pose (facing, nobody in shot) needs a fresh image.
    if (c.hard.some((r) => NEEDS_FRESH.test(r))) {
      prompt = `${job.prompt} Fix: ${fixLine(c.hard)}.`
      references = job.references
      retryNote = 'retry: the prompt ends with a "Fix:" sentence saying what the previous try got wrong, in plan words (not new content)'
    } else {
      const identity = personIn(job.look) && ctx.portrait ? [job.references[0]] : []
      prompt = editPrompt(fixLine(c.hard).replace(/the first image/g, 'the second image'))
      references = [g.fileId, ...identity]
      retryNote = 'retry as an EDIT of the previous try (the first image); only the named fix changes, everything else is kept from it'
    }
  }
  return withTries({ result: { ...base, fileId: last!.fileId, status: 'failed', reasons: last!.reasons }, ledger })
}
