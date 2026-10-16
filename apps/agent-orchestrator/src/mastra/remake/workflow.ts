// The clone remake (spec §3, §5.3–5.4, §8a): plan → cast → checked stills → FREE preview →
// clips → finish (join, music, final checks). Suspends for the plan review, the cast pick and
// the preview review; the remake_video tool resumes.
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { join } from 'node:path'
import type { Breakdown } from '../tools/videoBreakdown/breakDownVideo.js'
import type { MediaExecContext } from '../tools/batchRunner.js'
import { generatedFileKey } from '../../persistence.js'
import { remakeDeps, type RemakeDeps } from './deps.js'
import { runToken } from './runTokens.js'
import { writePlan, applyEdits } from './plan.js'
import { estimateCost, estimateClipsCost, ledgerSummary } from './cost.js'
import { castSheetPrompt, stillPrompt, stillGateInput, usesProduct, REFERENCE_SHEET_PROMPT, CAST_BY_IMAGE } from './prompts.js'
import { makeStill, type StillCtx, type StillJob } from './paidStill.js'
import { previewSegments, previewSize, usableStill } from './preview.js'
import { personIn } from './looks.js'
import { clipSpecs, lookFrames, CLIP_FPS, type ClipSpec } from './clipSpec.js'
import { makeClip, type ClipCtx, type ClipResult } from './paidClip.js'
import { checkClip } from './clipCheck.js'
import { musicPrompt } from './music.js'
import { differenceNote } from './finalNote.js'
import { runGate } from '../scorers/video/gate.js'
import type { Brand, LedgerEntry, PlanLine, RemakePlan, StillResult } from './types.js'

export class RemakeAccessError extends Error {}
class NothingToShow extends Error {}
const MAX_PARALLEL = 4
const any = z.any()

type Rc = { get: (k: string) => unknown }
function access(rc: Rc, tenantId: string, runId: string) {
  const t = rc.get('tenantId') as string | undefined
  // From the tool call's memory (never stored with the run); a direct caller may pass it in rc.
  const idToken = runToken(runId) ?? (rc.get('idToken') as string | undefined)
  if (!t || t !== tenantId || !idToken) throw new RemakeAccessError('not_found')
  const conversationId = (rc.get('conversationId') as string | undefined) ?? (rc.get('sessionId') as string | undefined) ?? 'unknown'
  return { tenantId: t, idToken, conversationId, scopeId: t }
}
// Charge keys: generateImageItem hashes this id with stableToolCallId; the slot is the item index.
// The generation items read idToken from their request context; give it to them here, so it
// never has to live in the run's stored context.
const execFor = (rc: Rc, runId: string, idToken: string) => (_slot: number): MediaExecContext => ({
  requestContext: { get: (k: string) => (k === 'idToken' ? idToken : rc.get(k)) },
  agent: { toolCallId: `remake:${runId}` },
})

const inputSchema = z.object({ tenantId: z.string(), conversationId: z.string(), breakdown: any, brand: any, castFileId: z.string().optional() })
const planned = inputSchema.extend({ plan: any })

const planStep = createStep({
  id: 'plan', inputSchema, outputSchema: planned,
  suspendSchema: z.object({ stage: z.literal('plan_review'), plan: any, estimate: any }),
  resumeSchema: z.object({ decision: z.enum(['edit', 'approve']), edits: z.array(any).optional() }),
  execute: async ({ inputData, resumeData, suspendData, suspend, requestContext, runId }) => {
    const { tenantId } = access(requestContext as Rc, inputData.tenantId, runId)
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
const casted = planned.extend({ portraitFileId: z.string().nullable(), referenceSheetFileId: z.string().nullable().optional(), ledger: z.array(any) })
const castStep = createStep({
  id: 'cast', inputSchema: planned, outputSchema: casted,
  // sheetFileId null = no sheet yet (it was blocked or could not be made); `error` is plain words.
  suspendSchema: z.object({ stage: z.literal('cast_pick'), sheetFileId: z.string().nullable(), sheetCreditsMicro: z.string(), error: z.string().optional() }),
  // no pick = make the sheet again (only when there is none); a pick crops that panel
  resumeSchema: z.object({ pick: z.number().int().min(1).max(3).optional() }),
  execute: async ({ inputData, resumeData, suspendData, suspend, requestContext, runId }) => {
    const a = access(requestContext as Rc, inputData.tenantId, runId)
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
      const g = await deps.generateStill({ prompt, aspectRatio: '16:9', engine: 'gemini', skipAvatarExpansion: true, title: 'Remake casting sheet' }, execFor(requestContext as Rc, runId, a.idToken)(0), 0)
      if (!g.fileId) {
        if (!g.insufficientCredits) console.error('[remake] casting sheet not made:', g.refusalReason ?? 'unknown')
        return await suspend({ stage: 'cast_pick', sheetFileId: null, sheetCreditsMicro: spentSoFar, error: g.insufficientCredits ? 'not enough credits for the casting sheet' : 'the casting sheet could not be made' })
      }
      return await suspend({ stage: 'cast_pick', sheetFileId: g.fileId, sheetCreditsMicro: String(BigInt(spentSoFar) + BigInt(g.creditsUsedMicro ?? '0')) })
    }
    if (!resumeData?.pick) return await suspend({ stage: 'cast_pick', sheetFileId: sheetId, sheetCreditsMicro: spentSoFar })
    const dir = deps.tempDir('remake-cast-')
    try {
      const sheetPath = await deps.localFile(sheetId, a.idToken, a.scopeId)
      const out = join(dir, `cast-${resumeData.pick}.jpg`)
      await deps.ffmpeg(['-i', sheetPath, '-vf', `crop=iw/3:ih:(${resumeData.pick}-1)*iw/3:0`, '-frames:v', '1', '-q:v', '2', out])
      const id = await deps.upload(a.idToken, generatedFileKey(a.conversationId, `remake ${runId} cast ${resumeData.pick}`, 'jpg'), `Remake cast ${resumeData.pick}.jpg`, deps.readFile(out), 'image/jpeg')
      if (!id) throw new Error('upload returned no file')
      const sheet: LedgerEntry = { item: 'casting sheet', attempt: 0, creditsMicro: spentSoFar, outcome: 'kept' }
      const ref = await referenceSheet(id, a, deps, execFor(requestContext as Rc, runId, a.idToken)(1))
      return { ...inputData, portraitFileId: id, referenceSheetFileId: ref.fileId, ledger: [sheet, ...ref.ledger] }
    } catch (err) {
      console.error('[remake] saving the chosen person failed:', err instanceof Error ? err.message : String(err))
      return await suspend({ stage: 'cast_pick', sheetFileId: sheetId, sheetCreditsMicro: spentSoFar, error: 'the chosen person could not be saved; please pick again' })
    } finally {
      deps.removeDir(dir)
    }
  },
})

// The chosen person's reference sheet (front, 3/4, profile, full body) leads every still and is the
// face check's reference (face consistency is hard). Gated like every paid call; a sheet that can't be
// made never ends the run: the stills fall back to the cropped portrait.
async function referenceSheet(portraitId: string, a: { tenantId: string }, deps: RemakeDeps, exec: ReturnType<ReturnType<typeof execFor>>): Promise<{ fileId: string | null; ledger: LedgerEntry[] }> {
  try {
    const prompt = REFERENCE_SHEET_PROMPT
    const gate = await deps.promptGate({ prompt, planLine: `reference sheet of the chosen person; ${CAST_BY_IMAGE}`, look: {}, startFrameObjects: [], keyMoments: [], tenantId: a.tenantId })
    if (gate.status !== 'pass') {
      console.error('[remake] reference sheet not checked/passed:', gate.status, gate.reason)
      return { fileId: null, ledger: [{ item: 'reference sheet', attempt: 0, creditsMicro: '0', outcome: 'blocked' }] }
    }
    const g = await deps.generateStill({ prompt, aspectRatio: '16:9', referenceFileIds: [portraitId], engine: 'gemini', skipAvatarExpansion: true, title: 'Remake reference sheet' }, exec, 1)
    if (!g.fileId) console.error('[remake] reference sheet not made:', g.refusalReason ?? (g.insufficientCredits ? 'credits' : 'unknown'))
    return { fileId: g.fileId ?? null, ledger: [{ item: 'reference sheet', attempt: 0, creditsMicro: g.creditsUsedMicro ?? '0', outcome: g.fileId ? 'kept' : 'failed' }] }
  } catch (err) {
    console.error('[remake] reference sheet failed:', err instanceof Error ? err.message : String(err))
    return { fileId: null, ledger: [] }
  }
}

const stilled = casted.extend({ stills: z.array(any) })
const stillsStep = createStep({
  id: 'stills', inputSchema: casted, outputSchema: stilled,
  execute: async ({ inputData, requestContext, runId }) => {
    const a = access(requestContext as Rc, inputData.tenantId, runId)
    const deps = remakeDeps()
    const plan = inputData.plan as RemakePlan
    const brand = inputData.brand as Brand
    const dir = deps.tempDir('remake-guides-')
    const source = await deps.localFile(plan.reference.videoFileId, a.idToken, a.scopeId)
    const guide = async (n: number, kind: 'start' | 'end', t: number) => {
      const out = join(dir, `guide-${n}-${kind}.jpg`)
      await deps.ffmpeg(['-ss', String(Math.max(0, t)), '-i', source, '-frames:v', '1', '-q:v', '2', out])
      return deps.upload(a.idToken, generatedFileKey(a.conversationId, `remake ${runId} look ${n} ${kind} guide`, 'jpg'), `Remake look ${n} ${kind} guide.jpg`, deps.readFile(out), 'image/jpeg')
    }
    // Identity: the reference sheet when there is one, else the cropped portrait.
    const portraitId = (inputData.referenceSheetFileId as string | null | undefined) ?? inputData.portraitFileId
    const portrait = portraitId ? { fileId: portraitId, img: await deps.fetchImage(portraitId, a.idToken) } : null
    const product = brand.productPhotoFileId && usesProduct(plan, brand) ? brand.productPhotoFileId : null
    const ctx: StillCtx = { tenantId: a.tenantId, idToken: a.idToken, scopeId: a.scopeId, runId, exec: execFor(requestContext as Rc, runId, a.idToken), portrait }
    ctx.outOfCredits = () => outOfCredits
    // The anchor: the first kept person still, passed to the rest (same person, same light). Not when a
    // product photo needs the third reference slot (the product must show exactly).
    let anchor: string | null = null
    const jobs: Array<{ person: boolean; run: () => Promise<{ result: StillResult; ledger: LedgerEntry[] }> }> = []
    // Once credits run out, the remaining stills stop before any guide, gate or call (M3).
    let outOfCredits = false
    const noCredits = (look: number, kind: 'start' | 'end') => ({ result: { look, kind, fileId: null, status: 'failed' as const, reasons: ['not enough credits'] }, ledger: [] })
    // Pose-guide frames show the original person: deleted from the user's files after use (M4).
    const guideIds: string[] = []
    for (const look of plan.looks) {
      for (const kind of (look.needsEndStill ? ['start', 'end'] : ['start']) as Array<'start' | 'end'>) {
        jobs.push({ person: personIn(look), run: async () => {
          // Never paid: a look whose people were not measured (spec §8a).
          if (!look.measuredPeople) return { result: { look: look.n, kind, fileId: null, status: 'blocked', reasons: ['this part of the video couldn’t be measured, so its still wasn’t made'] }, ledger: [] }
          // One still failing never ends the run: earlier stills are paid for and must reach the ledger and the preview.
          if (outOfCredits) return noCredits(look.n, kind)
          try {
            const g = await guide(look.n, kind, kind === 'start' ? look.guideStartS : look.guideEndS)
            if (g) guideIds.push(g)
            if (outOfCredits) return noCredits(look.n, kind)
            if (!g) return { result: { look: look.n, kind, fileId: null, status: 'blocked', reasons: ['the pose guide could not be saved'] }, ledger: [] }
            const person = personIn(look)
            const references = [...(person && portrait ? [portrait.fileId] : []), g, ...(product ? [product] : person && anchor ? [anchor] : [])]
            const prompt = stillPrompt(plan, look, kind, brand, !!product)
            const job: StillJob = { look, kind, prompt, references, aspectRatio: plan.aspectRatio, gate: stillGateInput(plan, look, kind, prompt) }
            if (outOfCredits) return noCredits(look.n, kind)
            const made = await makeStill(job, ctx, deps)
            if (made.result.reasons.some((r) => r.includes('not enough credits'))) outOfCredits = true
            return made
          } catch (err) {
            console.error(`[remake] look ${look.n} ${kind} still failed:`, err instanceof Error ? err.message : String(err))
            return { result: { look: look.n, kind, fileId: null, status: 'failed', reasons: ['this still could not be made this time'] }, ledger: [] }
          }
        } })
      }
    }
    const done: Array<{ result: StillResult; ledger: LedgerEntry[] }> = []
    try {
      const first = jobs.findIndex((j) => j.person)
      const firstDone = first >= 0 ? await jobs[first].run() : null
      if (firstDone && !product) anchor = usableStill(firstDone.result)
      const rest = jobs.filter((_, i) => i !== first)
      const restDone: typeof done = []
      for (let i = 0; i < rest.length; i += MAX_PARALLEL) restDone.push(...await Promise.all(rest.slice(i, i + MAX_PARALLEL).map((j) => j.run())))
      // Back in plan order.
      done.push(...jobs.map((j, i) => (i === first ? firstDone! : restDone[rest.indexOf(j)])))
    } finally {
      deps.removeDir(dir)
      await Promise.all(guideIds.map((id) => deps.deleteFile(a.idToken, id)))
    }
    return { ...inputData, stills: done.map((d) => d.result), ledger: [...(inputData.ledger as LedgerEntry[]), ...done.flatMap((d) => d.ledger)] }
  },
})

const previewed = stilled.extend({ previewFileId: z.string().nullable(), stop: z.boolean() })
const previewStep = createStep({
  id: 'preview', inputSchema: stilled, outputSchema: previewed,
  suspendSchema: z.object({ stage: z.literal('preview_review'), previewFileId: z.string().nullable(), stills: z.array(any), summary: any, clipsEstimate: any.optional(), cantAnimate: z.string().optional() }),
  resumeSchema: z.object({ decision: z.enum(['approve', 'stop']) }),
  execute: async ({ inputData, requestContext, runId, resumeData, suspendData, suspend }) => {
    const a = access(requestContext as Rc, inputData.tenantId, runId)
    const deps = remakeDeps()
    const plan = inputData.plan as RemakePlan
    const stills = inputData.stills as StillResult[]
    const ledger = inputData.ledger as LedgerEntry[]
    // Square: the video models make only 9:16 or 16:9 (Review Focus 2).
    // Nothing to animate when no part has a usable start still (live run 08466630 went on to
    // an all-grey "finished" video).
    const anyStill = stills.some((s) => s.kind === 'start' && !!usableStill(s))
    const cantAnimate = plan.aspectRatio === '1:1' ? 'Square videos can be previewed but not animated yet.'
      : !anyStill ? 'None of the stills could be made, so there is nothing to animate yet. Change the plan and start the remake again.' : undefined
    if (resumeData) {
      return { ...inputData, previewFileId: (suspendData?.previewFileId as string | null | undefined) ?? null, stop: resumeData.decision === 'stop' || !!cantAnimate }
    }
    let previewFileId: string | null = null
    const previewDir = deps.tempDir('remake-preview-')
    try {
      const paths = new Map<string, string>()
      for (const s of stills) if (s.fileId) paths.set(s.fileId, await deps.localFile(s.fileId, a.idToken, a.scopeId))
      const { width, height } = previewSize(plan.reference.width || 1080, plan.reference.height || 1920)
      const out = await deps.renderPreview({ workDir: previewDir, width, height, segments: previewSegments(plan, stills, paths) })
      previewFileId = await deps.upload(a.idToken, generatedFileKey(a.conversationId, `remake ${runId} preview`, 'mp4'), 'Remake preview.mp4', deps.readFile(out), 'video/mp4')
    } catch (err) {
      console.error('[remake] preview failed:', err instanceof Error ? err.message : String(err))
    } finally {
      deps.removeDir(previewDir)
    }
    // A reel that can't be animated gets no clips price (M4).
    const clipsEstimate = cantAnimate ? undefined : estimateClipsCost(clipSpecs(plan, stills), { veo: await deps.clipRateMicro('veo'), omni: await deps.clipRateMicro('omni'), music: await deps.musicRateMicro() })
    return await suspend({ stage: 'preview_review', previewFileId, stills, summary: ledgerSummary(ledger), ...(clipsEstimate ? { clipsEstimate } : {}), ...(cantAnimate ? { cantAnimate } : {}) })
  },
})

const MAX_PARALLEL_CLIPS = 3
const clipped = previewed.extend({ clips: z.array(any), clipsDir: z.string().nullable() })
const clipsStep = createStep({
  id: 'clips', inputSchema: previewed, outputSchema: clipped,
  execute: async ({ inputData, requestContext, runId }) => {
    const a = access(requestContext as Rc, inputData.tenantId, runId)
    if (inputData.stop) return { ...inputData, clips: [], clipsDir: null }
    const deps = remakeDeps()
    const plan = inputData.plan as RemakePlan
    const identityId = (inputData.referenceSheetFileId as string | null | undefined) ?? inputData.portraitFileId
    const portrait = identityId ? await deps.fetchImage(identityId, a.idToken) : null
    const size = previewSize(plan.reference.width || 1080, plan.reference.height || 1920)
    // Kept until the finish step has joined the clips; removed there.
    const workDir = deps.tempDir('remake-clips-')
    const ctx: ClipCtx = {
      tenantId: a.tenantId, idToken: a.idToken, scopeId: a.scopeId, runId, exec: execFor(requestContext as Rc, runId, a.idToken),
      portrait, plan, brand: inputData.brand as Brand, size, workDir,
      check: (clipPath: string, spec: ClipSpec, engine: 'veo' | 'omni') => checkClip({ clipPath, seconds: spec.frames / CLIP_FPS, look: spec.look, portrait, tenantId: a.tenantId, checkEnd: engine === 'veo' }, { poseClip: deps.poseClip, sample: deps.sample, gate: runGate }),
    }
    const jobs = clipSpecs(plan, inputData.stills as StillResult[]).map((spec) => async (): Promise<{ result: ClipResult; ledger: LedgerEntry[] }> => {
      // One clip failing never ends the run, and every attempt it paid for stays in its ledger.
      const ledger: LedgerEntry[] = []
      try {
        return await makeClip(spec, ctx, deps, ledger)
      } catch (err) {
        console.error(`[remake] look ${spec.look.n} clip failed:`, err instanceof Error ? err.message : String(err))
        return { result: { look: spec.look.n, fileId: null, localPath: null, engine: spec.engine, fallback: false, status: 'failed', reasons: ['this part could not be animated this time'] }, ledger }
      }
    })
    const done: Array<{ result: ClipResult; ledger: LedgerEntry[] }> = []
    for (let i = 0; i < jobs.length; i += MAX_PARALLEL_CLIPS) done.push(...await Promise.all(jobs.slice(i, i + MAX_PARALLEL_CLIPS).map((j) => j())))
    return { ...inputData, clipsDir: workDir, clips: done.map((d) => d.result), ledger: [...(inputData.ledger as LedgerEntry[]), ...done.flatMap((d) => d.ledger)] }
  },
})

const outputSchema = z.object({ finalFileId: z.string().nullable(), stopped: z.boolean(), nothingToShow: z.boolean().optional(), previewFileId: z.string().nullable(), clips: z.array(any), stills: z.array(any), portraitFileId: z.string().nullable(), ledger: z.array(any), summary: any, note: z.string(), plan: any })
const MUSIC_SLOT = 2000
const finishStep = createStep({
  id: 'finish', inputSchema: clipped, outputSchema,
  execute: async ({ inputData, requestContext, runId }) => {
    const a = access(requestContext as Rc, inputData.tenantId, runId)
    const plan = inputData.plan as RemakePlan
    const stills = inputData.stills as StillResult[]
    const clips = inputData.clips as ClipResult[]
    const ledger = [...(inputData.ledger as LedgerEntry[])]
    const base = { previewFileId: inputData.previewFileId, clips, stills, portraitFileId: inputData.portraitFileId, plan, stopped: inputData.stop }
    if (inputData.stop) return { ...base, finalFileId: null, ledger, summary: ledgerSummary(ledger), note: '' }
    const deps = remakeDeps()
    const size = previewSize(plan.reference.width || 1080, plan.reference.height || 1920)
    const work = deps.tempDir('remake-final-')
    const frames = lookFrames(plan)
    const extra: string[] = []
    let finalFileId: string | null = null
    let musicMade = false
    let realParts = 0
    try {
      const parts: string[] = []
      for (const look of [...plan.looks].sort((x, y) => x.startS - y.startS)) {
        const n = frames.get(look.n) ?? 0
        const clip = clips.find((c) => c.look === look.n && c.localPath && (c.status === 'passed' || c.status === 'unchecked' || c.status === 'failed'))
        if (clip?.localPath) { parts.push(clip.localPath); realParts++; continue }
        const still = stills.find((s) => s.look === look.n && s.kind === 'start' && s.fileId)
        // A still that can't be fetched becomes a grey card: one file never costs the whole video.
        let path: string | null = null
        if (still?.fileId) {
          try { path = await deps.localFile(still.fileId, a.idToken, a.scopeId) } catch (err) {
            console.error(`[remake] still for look ${look.n} unavailable:`, err instanceof Error ? err.message : String(err))
          }
        }
        if (path) realParts++
        parts.push(await deps.stillToFrames(path, n, join(work, `still-${look.n}.mp4`), size))
      }
      // No real picture in any part: never deliver grey cards as a finished video, and pay
      // for no music or comparison.
      if (realParts === 0) throw new NothingToShow()
      let video = await deps.joinSegments(parts, join(work, 'joined.mp4'))
      const totalS = [...frames.values()].reduce((x, y) => x + y, 0) / CLIP_FPS
      // Music: always new (spec §9a), gated like every paid call. Its own guard: any failure
      // leaves the finished video silent, never lost.
      try {
        const prompt = musicPrompt(plan)
        const gate = await deps.promptGate({ prompt, planLine: `music: ${plan.lines.find((l) => l.ref === 'sound.music')?.to ?? 'new music'}`, look: {}, startFrameObjects: [], keyMoments: [], tenantId: a.tenantId })
        if (gate.status !== 'pass') console.error('[remake] music prompt not passed:', gate.status, gate.reason)
        const music = gate.status === 'pass' ? await deps.generateMusic(prompt, execFor(requestContext as Rc, runId, a.idToken)(MUSIC_SLOT), `remake:${runId}:music`) : null
        if (music) ledger.push({ item: 'music', attempt: 0, creditsMicro: music.creditsUsedMicro ?? '0', outcome: music.fileId ? 'kept' : 'failed' })
        if (music?.fileId) {
          const fitted = await deps.fitMusic(await deps.localFile(music.fileId, a.idToken, a.scopeId), totalS, join(work, 'music.m4a'))
          video = await deps.muxMusic(video, fitted, join(work, 'final.mp4'))
          musicMade = true
        } else if (music?.insufficientCredits) {
          extra.push('The music couldn’t be made (not enough credits), so the video is silent.')
        }
      } catch (err) {
        console.error('[remake] music failed:', err instanceof Error ? err.message : String(err))
      }
      if (!musicMade && !extra.length) extra.push('The music couldn’t be made this time, so the video is silent.')
      finalFileId = await deps.upload(a.idToken, generatedFileKey(a.conversationId, `remake ${runId} final`, 'mp4'), 'Remake.mp4', deps.readFile(video), 'video/mp4')
      if (!finalFileId) extra.push('The final video couldn’t be saved this time.')
    } catch (err) {
      if (err instanceof NothingToShow) {
        extra.push('No part of the video could be made, so nothing was put together.')
      } else {
        console.error('[remake] finish failed:', err instanceof Error ? err.message : String(err))
        extra.push('The final video couldn’t be put together this time.')
      }
    } finally {
      deps.removeDir(work)
      if (inputData.clipsDir) deps.removeDir(inputData.clipsDir)
    }
    let checks = null
    if (finalFileId) {
      try {
        checks = (await deps.compare(inputData.breakdown as Breakdown, finalFileId, { idToken: a.idToken, scopeId: a.scopeId, conversationId: a.conversationId }, a.tenantId)).checks
      } catch (err) {
        console.error('[remake] final comparison failed:', err instanceof Error ? err.message : String(err))
      }
    }
    const lines = differenceNote({ plan, stills, clips, checks, musicMade }).split('\n')
    const note = [...lines.slice(0, -1), ...extra, lines[lines.length - 1]].join('\n')
    return { ...base, finalFileId, ledger, summary: ledgerSummary(ledger), note, ...(realParts === 0 ? { nothingToShow: true } : {}) }
  },
})

export const videoRemakeWorkflow = createWorkflow({ id: 'video-remake', inputSchema, outputSchema })
  .then(planStep).then(castStep).then(stillsStep).then(previewStep).then(clipsStep).then(finishStep).commit()
