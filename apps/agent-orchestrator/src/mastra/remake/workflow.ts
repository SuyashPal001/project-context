// Phase 3a of the clone (spec §3, §5.3–5.4, §8a): plan → cast → checked stills → FREE
// preview. Suspends for the plan review and the cast pick; the remake_video tool resumes.
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Breakdown } from '../tools/videoBreakdown/breakDownVideo.js'
import type { MediaExecContext } from '../tools/batchRunner.js'
import { generatedFileKey } from '../../persistence.js'
import { remakeDeps } from './deps.js'
import { writePlan, applyEdits } from './plan.js'
import { estimateCost, ledgerSummary } from './cost.js'
import { castSheetPrompt, stillPrompt, stillGateInput, usesProduct } from './prompts.js'
import { makeStill, type StillCtx, type StillJob } from './paidStill.js'
import { previewSegments, previewSize } from './preview.js'
import { personIn } from './looks.js'
import type { Brand, LedgerEntry, PlanLine, RemakePlan, StillResult } from './types.js'

export class RemakeAccessError extends Error {}
const MAX_PARALLEL = 4
const any = z.any()

type Rc = { get: (k: string) => unknown }
function access(rc: Rc, tenantId: string) {
  const t = rc.get('tenantId') as string | undefined
  const idToken = rc.get('idToken') as string | undefined
  if (!t || t !== tenantId || !idToken) throw new RemakeAccessError('not_found')
  const conversationId = (rc.get('conversationId') as string | undefined) ?? (rc.get('sessionId') as string | undefined) ?? 'unknown'
  return { tenantId: t, idToken, conversationId, scopeId: t }
}
// Charge keys: generateImageItem hashes this id with stableToolCallId; the slot is the item index.
const execFor = (rc: Rc, runId: string) => (_slot: number): MediaExecContext => ({ requestContext: rc, agent: { toolCallId: `remake:${runId}` } })

const inputSchema = z.object({ tenantId: z.string(), conversationId: z.string(), breakdown: any, brand: any, castFileId: z.string().optional() })
const planned = inputSchema.extend({ plan: any })

const planStep = createStep({
  id: 'plan', inputSchema, outputSchema: planned,
  suspendSchema: z.object({ stage: z.literal('plan_review'), plan: any, estimate: any }),
  resumeSchema: z.object({ decision: z.enum(['edit', 'approve']), edits: z.array(any).optional() }),
  execute: async ({ inputData, resumeData, suspendData, suspend, requestContext }) => {
    const { tenantId } = access(requestContext as Rc, inputData.tenantId)
    const deps = remakeDeps()
    const brand = inputData.brand as Brand
    let plan = (suspendData?.plan as RemakePlan | undefined) ?? await writePlan(inputData.breakdown as Breakdown, brand, deps.ask(tenantId))
    if (resumeData?.decision === 'approve' && suspendData?.plan) return { ...inputData, plan }
    if (resumeData?.decision === 'edit') plan = applyEdits(plan, (resumeData.edits ?? []) as PlanLine[], brand)
    const estimate = estimateCost(plan, { castProvided: !!inputData.castFileId, microEach: await deps.imageRateMicro() })
    return await suspend({ stage: 'plan_review', plan, estimate })
  },
})

// the casting sheet's charge rides along so the cost meter counts it
const casted = planned.extend({ portraitFileId: z.string().nullable(), ledger: z.array(any) })
const castStep = createStep({
  id: 'cast', inputSchema: planned, outputSchema: casted,
  // sheetFileId null = no sheet yet (it was blocked or could not be made); `error` is plain words.
  suspendSchema: z.object({ stage: z.literal('cast_pick'), sheetFileId: z.string().nullable(), sheetCreditsMicro: z.string(), error: z.string().optional() }),
  // no pick = make the sheet again (only when there is none); a pick crops that panel
  resumeSchema: z.object({ pick: z.number().int().min(1).max(3).optional() }),
  execute: async ({ inputData, resumeData, suspendData, suspend, requestContext, runId }) => {
    const a = access(requestContext as Rc, inputData.tenantId)
    const plan = inputData.plan as RemakePlan
    if (!plan.needsCasting) return { ...inputData, portraitFileId: null, ledger: [] }
    if (inputData.castFileId) return { ...inputData, portraitFileId: inputData.castFileId, ledger: [] }
    const deps = remakeDeps()
    const sheetId = (suspendData?.sheetFileId as string | null | undefined) ?? null
    const spentSoFar = (suspendData?.sheetCreditsMicro as string | undefined) ?? '0'
    if (!sheetId) {
      // A failure here never ends the run: the user can fix the plan or add credits and ask again.
      const castTo = plan.lines.find((l) => l.ref === 'cast')?.to ?? 'a new person'
      const prompt = castSheetPrompt(castTo)
      const gate = await deps.promptGate({ prompt, planLine: `casting sheet; cast: swap to ${castTo}`, look: {}, startFrameObjects: [], keyMoments: [], tenantId: a.tenantId })
      if (gate.status !== 'pass') {
        if (gate.status === 'unknown') console.error('[remake] casting sheet prompt check unavailable:', gate.reason)
        const error = gate.status === 'unknown' ? 'the casting sheet couldn’t be checked before making it, so it wasn’t made; try again in a minute' : `the casting sheet wasn’t made: ${gate.reason}`
        return await suspend({ stage: 'cast_pick', sheetFileId: null, sheetCreditsMicro: spentSoFar, error })
      }
      const g = await deps.generateStill({ prompt, aspectRatio: '16:9', engine: 'gemini', skipAvatarExpansion: true, title: 'Remake casting sheet' }, execFor(requestContext as Rc, runId)(0), 0)
      if (!g.fileId) {
        if (!g.insufficientCredits) console.error('[remake] casting sheet not made:', g.refusalReason ?? 'unknown')
        return await suspend({ stage: 'cast_pick', sheetFileId: null, sheetCreditsMicro: spentSoFar, error: g.insufficientCredits ? 'not enough credits for the casting sheet' : 'the casting sheet could not be made' })
      }
      return await suspend({ stage: 'cast_pick', sheetFileId: g.fileId, sheetCreditsMicro: String(BigInt(spentSoFar) + BigInt(g.creditsUsedMicro ?? '0')) })
    }
    if (!resumeData?.pick) return await suspend({ stage: 'cast_pick', sheetFileId: sheetId, sheetCreditsMicro: spentSoFar })
    try {
      const dir = mkdtempSync(join(tmpdir(), 'remake-cast-'))
      const sheetPath = await deps.localFile(sheetId, a.idToken, a.scopeId)
      const out = join(dir, `cast-${resumeData.pick}.jpg`)
      await deps.ffmpeg(['-i', sheetPath, '-vf', `crop=iw/3:ih:(${resumeData.pick}-1)*iw/3:0`, '-frames:v', '1', '-q:v', '2', out])
      const id = await deps.upload(a.idToken, generatedFileKey(a.conversationId, `remake ${runId} cast ${resumeData.pick}`, 'jpg'), `Remake cast ${resumeData.pick}.jpg`, deps.readFile(out), 'image/jpeg')
      if (!id) throw new Error('upload returned no file')
      const sheet: LedgerEntry = { item: 'casting sheet', attempt: 0, creditsMicro: spentSoFar, outcome: 'kept' }
      return { ...inputData, portraitFileId: id, ledger: [sheet] }
    } catch (err) {
      console.error('[remake] saving the chosen person failed:', err instanceof Error ? err.message : String(err))
      return await suspend({ stage: 'cast_pick', sheetFileId: sheetId, sheetCreditsMicro: spentSoFar, error: 'the chosen person could not be saved; please pick again' })
    }
  },
})

const stilled = casted.extend({ stills: z.array(any) })
const stillsStep = createStep({
  id: 'stills', inputSchema: casted, outputSchema: stilled,
  execute: async ({ inputData, requestContext, runId }) => {
    const a = access(requestContext as Rc, inputData.tenantId)
    const deps = remakeDeps()
    const plan = inputData.plan as RemakePlan
    const brand = inputData.brand as Brand
    const dir = mkdtempSync(join(tmpdir(), 'remake-guides-'))
    const source = await deps.localFile(plan.reference.videoFileId, a.idToken, a.scopeId)
    const guide = async (n: number, kind: 'start' | 'end', t: number) => {
      const out = join(dir, `guide-${n}-${kind}.jpg`)
      await deps.ffmpeg(['-ss', String(Math.max(0, t)), '-i', source, '-frames:v', '1', '-q:v', '2', out])
      return deps.upload(a.idToken, generatedFileKey(a.conversationId, `remake ${runId} look ${n} ${kind} guide`, 'jpg'), `Remake look ${n} ${kind} guide.jpg`, deps.readFile(out), 'image/jpeg')
    }
    const portraitId = inputData.portraitFileId
    const portrait = portraitId ? { fileId: portraitId, img: await deps.fetchImage(portraitId, a.idToken) } : null
    const product = brand.productPhotoFileId && usesProduct(plan, brand) ? brand.productPhotoFileId : null
    const ctx: StillCtx = { tenantId: a.tenantId, idToken: a.idToken, scopeId: a.scopeId, runId, exec: execFor(requestContext as Rc, runId), portrait }
    const jobs: Array<() => Promise<{ result: StillResult; ledger: LedgerEntry[] }>> = []
    for (const look of plan.looks) {
      for (const kind of (look.needsEndStill ? ['start', 'end'] : ['start']) as Array<'start' | 'end'>) {
        jobs.push(async () => {
          // Never paid: a look whose people were not measured (spec §8a).
          if (!look.measuredPeople) return { result: { look: look.n, kind, fileId: null, status: 'blocked', reasons: ['this part of the video couldn’t be measured, so its still wasn’t made'] }, ledger: [] }
          // One still failing never ends the run: earlier stills are paid for and must reach the ledger and the preview.
          try {
            const g = await guide(look.n, kind, kind === 'start' ? look.guideStartS : look.guideEndS)
            if (!g) return { result: { look: look.n, kind, fileId: null, status: 'blocked', reasons: ['the pose guide could not be saved'] }, ledger: [] }
            const person = personIn(look)
            const references = [...(person && portrait ? [portrait.fileId] : []), g, ...(product ? [product] : [])]
            const prompt = stillPrompt(plan, look, kind, brand, !!product)
            const job: StillJob = { look, kind, prompt, references, aspectRatio: plan.aspectRatio, gate: stillGateInput(plan, look, kind, prompt) }
            return await makeStill(job, ctx, deps)
          } catch (err) {
            console.error(`[remake] look ${look.n} ${kind} still failed:`, err instanceof Error ? err.message : String(err))
            return { result: { look: look.n, kind, fileId: null, status: 'failed', reasons: ['this still could not be made this time'] }, ledger: [] }
          }
        })
      }
    }
    const done: Array<{ result: StillResult; ledger: LedgerEntry[] }> = []
    for (let i = 0; i < jobs.length; i += MAX_PARALLEL) done.push(...await Promise.all(jobs.slice(i, i + MAX_PARALLEL).map((j) => j())))
    return { ...inputData, stills: done.map((d) => d.result), ledger: [...(inputData.ledger as LedgerEntry[]), ...done.flatMap((d) => d.ledger)] }
  },
})

const outputSchema = z.object({ previewFileId: z.string().nullable(), stills: z.array(any), portraitFileId: z.string().nullable(), ledger: z.array(any), summary: any, plan: any })
const previewStep = createStep({
  id: 'preview', inputSchema: stilled, outputSchema,
  execute: async ({ inputData, requestContext, runId }) => {
    const a = access(requestContext as Rc, inputData.tenantId)
    const deps = remakeDeps()
    const plan = inputData.plan as RemakePlan
    const stills = inputData.stills as StillResult[]
    const ledger = inputData.ledger as LedgerEntry[]
    let previewFileId: string | null = null
    try {
      const paths = new Map<string, string>()
      for (const s of stills) if (s.fileId) paths.set(s.fileId, await deps.localFile(s.fileId, a.idToken, a.scopeId))
      const { width, height } = previewSize(plan.reference.width || 1080, plan.reference.height || 1920)
      const out = await deps.renderPreview({ workDir: mkdtempSync(join(tmpdir(), 'remake-preview-')), width, height, segments: previewSegments(plan, stills, paths) })
      previewFileId = await deps.upload(a.idToken, generatedFileKey(a.conversationId, `remake ${runId} preview`, 'mp4'), 'Remake preview.mp4', deps.readFile(out), 'video/mp4')
    } catch (err) {
      console.error('[remake] preview failed:', err instanceof Error ? err.message : String(err))
    }
    return { previewFileId, stills, portraitFileId: inputData.portraitFileId, ledger, summary: ledgerSummary(ledger), plan }
  },
})

export const videoRemakeWorkflow = createWorkflow({ id: 'video-remake', inputSchema, outputSchema })
  .then(planStep).then(castStep).then(stillsStep).then(previewStep).commit()
