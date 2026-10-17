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
import { castSheetPrompt, stylingOf, outfitOf, propsAt, stillPrompt, stillGateInput, usesProduct, REFERENCE_SHEET_PROMPT, CAST_BY_IMAGE, charactersAt, characterPortraitPrompt, stillTime, type CharacterImages } from './prompts.js'
import { makeStill, type StillCtx, type StillJob } from './paidStill.js'
import { looksUnder18 } from './stillChecks.js'
import { boardUnits, boardPrompt, boardGateInput, boardAspect, BOARD_SLOT } from './board.js'
import { previewSegments, previewSize, usableStill } from './preview.js'
import { personIn, refOf } from './looks.js'
import { editShotPrompt, editShotGateLine, placeGroups, type ShotChange } from '../tools/nextShot.js'
import type { Img } from '../tools/tvcChecks.js'
import { clipSpecs, lookFrames, CLIP_FPS, type ClipSpec } from './clipSpec.js'
import { makeClip, type ClipCtx, type ClipResult } from './paidClip.js'
import { checkClip } from './clipCheck.js'
import { musicPrompt } from './music.js'
import { differenceNote } from './finalNote.js'
import { runGate } from '../scorers/video/gate.js'
import type { Brand, LedgerEntry, PlanLine, RemakeLook, RemakePlan, StillResult } from './types.js'

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

const inputSchema = z.object({ tenantId: z.string(), conversationId: z.string(), breakdown: any, brand: any, castFileId: z.string().optional(), /** the user approves the person sheet before any still (the chat tool always sets it) */ reviewPerson: z.boolean().optional() })
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
const casted = planned.extend({ portraitFileId: z.string().nullable(), referenceSheetFileId: z.string().nullable().optional(), characterFileIds: z.record(z.string(), z.string()).optional(), stylingFileIds: z.record(z.string(), z.string()).optional(), ledger: z.array(any) })
const castStep = createStep({
  id: 'cast', inputSchema: planned, outputSchema: casted,
  // sheetFileId null = no sheet yet (it was blocked or could not be made); `error` is plain words.
  // cast_pick: choose one of three; person_review: approve the chosen person's sheet (or ask for a change)
  suspendSchema: z.object({ stage: z.enum(['cast_pick', 'person_review']), sheetFileId: z.string().nullable(), sheetCreditsMicro: z.string().optional(), error: z.string().optional(), out: any.optional() }),
  // no pick = make the sheet again (only when there is none); a pick crops that panel
  resumeSchema: z.object({ pick: z.number().int().min(1).max(3).optional(), decision: z.enum(['approve', 'edit']).optional(), change: z.string().optional(), /** none of the three fit: a new sheet, steered by the note */ recast: z.boolean().optional(), note: z.string().optional() }),
  execute: async ({ inputData, resumeData, suspendData, suspend, requestContext, runId }) => {
    const a = access(requestContext as Rc, inputData.tenantId, runId)
    const plan = inputData.plan as RemakePlan
    if (!plan.needsCasting) return { ...inputData, portraitFileId: null, ledger: [] }
    // The person is approved before any still (user, 2026-10-16, the Higgsfield way); a change is an edit
    // of the sheet, so the person stays the same.
    type CastOut = { portraitFileId: string | null; referenceSheetFileId?: string | null; characterFileIds?: Record<string, string>; ledger: LedgerEntry[] }
    const review = async (o: CastOut, error?: string) => {
      if (!inputData.reviewPerson || !o.referenceSheetFileId) return { ...inputData, ...o }
      return await suspend({ stage: 'person_review', sheetFileId: o.referenceSheetFileId, out: o, ...(error ? { error } : {}) })
    }
    if (suspendData?.stage === 'person_review' && suspendData.out) {
      const o = suspendData.out as CastOut
      if (resumeData?.decision === 'approve') return { ...inputData, ...o }
      if (resumeData?.decision === 'edit' && resumeData.change?.trim() && o.referenceSheetFileId) {
        const slot = SHEET_EDIT_SLOT + o.ledger.filter((l) => l.item === 'reference sheet change').length
        const e = await editSheet(o.referenceSheetFileId, resumeData.change.trim(), a, remakeDeps(), execFor(requestContext as Rc, runId, a.idToken)(slot), slot)
        const next = { ...o, ...(e.fileId ? { referenceSheetFileId: e.fileId } : {}), ledger: [...o.ledger, ...e.ledger] }
        return await review(next, e.fileId ? undefined : 'that change could not be made this time; the person is unchanged')
      }
      return await review(o)
    }
    if (inputData.castFileId) {
      // A person the customer brings gets the same reference sheet as a picked one (fan reel 2026-10-16:
      // without it their face held less well across stills and clips).
      const exec = execFor(requestContext as Rc, runId, a.idToken)
      const [ref, chars] = await Promise.all([referenceSheet(inputData.castFileId, a, remakeDeps(), exec(1), reelStyling(plan)), characterPortraits(plan, a, remakeDeps(), exec)])
      return await review({ portraitFileId: inputData.castFileId, referenceSheetFileId: ref.fileId, characterFileIds: chars.fileIds, ledger: [...ref.ledger, ...chars.ledger] })
    }
    const deps = remakeDeps()
    const sheetId = (suspendData?.sheetFileId as string | null | undefined) ?? null
    const spentSoFar = (suspendData?.sheetCreditsMicro as string | undefined) ?? '0'
    if (!sheetId || resumeData?.recast) {
      // A failure here never ends the run: the user can fix the plan or add credits and ask again.
      const castTo = plan.lines.find((l) => l.ref === 'cast')?.to ?? 'a new person'
      const prompt = castSheetPrompt(castTo, resumeData?.recast ? resumeData.note : undefined)
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
      // Free check before any still is paid: video is never made of anyone who may read as under 18.
      if (await looksUnder18(deps.ask(a.tenantId), await deps.fetchImage(id, a.idToken))) {
        return await suspend({ stage: 'cast_pick', sheetFileId: sheetId, sheetCreditsMicro: spentSoFar, error: `person ${resumeData.pick} could pass for under 18, and video can't be made of them; please pick another` })
      }
      const sheet: LedgerEntry = { item: 'casting sheet', attempt: 0, creditsMicro: spentSoFar, outcome: 'kept' }
      const exec = execFor(requestContext as Rc, runId, a.idToken)
      const [ref, chars] = await Promise.all([referenceSheet(id, a, deps, exec(1), reelStyling(plan)), characterPortraits(plan, a, deps, exec)])
      return await review({ portraitFileId: id, referenceSheetFileId: ref.fileId, characterFileIds: chars.fileIds, ledger: [sheet, ...ref.ledger, ...chars.ledger] })
    } catch (err) {
      console.error('[remake] saving the chosen person failed:', err instanceof Error ? err.message : String(err))
      return await suspend({ stage: 'cast_pick', sheetFileId: sheetId, sheetCreditsMicro: spentSoFar, error: 'the chosen person could not be saved; please pick again' })
    } finally {
      deps.removeDir(dir)
    }
  },
})

// One portrait per other character the plan casts (the girl in the metro reel's train window was drawn
// with the lead's face). Slots 2-3, so at most two; gated like every paid image; one that can't be made
// only leaves that character uncast (their stills go on without the portrait).
const MAX_CHARACTERS = 2
// One picture per distinct look styling (hair, jewellery, makeup), each an EDIT of the chosen person so
// the face stays theirs; that look's stills use it as the person. Checks stay on the base person.
// A change the user asks for on the person sheet: an EDIT of it, so the face stays the same person.
const SHEET_EDIT_SLOT = 700
async function editSheet(sheetId: string, change: string, a: { tenantId: string }, deps: RemakeDeps, exec: ReturnType<ReturnType<typeof execFor>>, slot: number): Promise<{ fileId: string | null; ledger: LedgerEntry[] }> {
  const item = 'reference sheet change'
  try {
    const prompt = `Edit this character reference sheet. Change only: ${change}. Keep exactly the same face, identity, skin tone, age and body in every panel, and the same layout and labels. Photoreal.`
    const gate = await deps.promptGate({ prompt, planLine: `edit of the chosen person's reference sheet (the image, not described in words): only the change the user asked for, ${change}; ${CAST_BY_IMAGE}`, look: {}, startFrameObjects: [], keyMoments: [], tenantId: a.tenantId })
    if (gate.status !== 'pass') {
      console.error('[remake] sheet change not checked/passed:', gate.status, gate.reason)
      return { fileId: null, ledger: [{ item, attempt: 0, creditsMicro: '0', outcome: 'blocked' }] }
    }
    const g = await deps.generateStill({ prompt, aspectRatio: '3:4', imageSize: '2K', referenceFileIds: [sheetId], engine: 'gemini', skipAvatarExpansion: true, title: 'Remake reference sheet (changed)' }, exec, slot)
    if (!g.fileId) console.error('[remake] sheet change not made:', g.refusalReason ?? (g.insufficientCredits ? 'credits' : 'unknown'))
    return { fileId: g.fileId ?? null, ledger: [{ item, attempt: 0, creditsMicro: g.creditsUsedMicro ?? '0', outcome: g.fileId ? 'kept' : 'failed' }] }
  } catch (err) {
    console.error('[remake] sheet change failed:', err instanceof Error ? err.message : String(err))
    return { fileId: null, ledger: [] }
  }
}

/** The styling of the reel's first look with the person: the person sheet is drawn in it. */
const reelStyling = (plan: RemakePlan): string => { const l = plan.looks.find(personIn); return l ? stylingOf(plan, l) : '' }

async function characterPortraits(plan: RemakePlan, a: { tenantId: string }, deps: RemakeDeps, exec: ReturnType<typeof execFor>): Promise<{ fileIds: Record<string, string>; ledger: LedgerEntry[] }> {
  const fileIds: Record<string, string> = {}
  const ledger: LedgerEntry[] = []
  const cast = (plan.reference.characters ?? []).flatMap((c, i) => {
    const l = plan.lines.find((x) => x.ref === `characters[${i}]`)
    return l?.action === 'swap' && l.to ? [{ i, who: c.who, to: l.to }] : []
  }).slice(0, MAX_CHARACTERS)
  await Promise.all(cast.map(async (c, k) => {
    const item = `portrait of the ${c.who}`
    try {
      const prompt = characterPortraitPrompt(c.to)
      const gate = await deps.promptGate({ prompt, planLine: `casting portrait of a new person for this role: a plain studio head-and-shoulders photo of who they are; the scene, pose and expression come later in the stills, so a studio background, a neutral face and facing the camera are expected; characters[${c.i}]: swap to ${c.to}`, look: {}, startFrameObjects: [], keyMoments: [], tenantId: a.tenantId })
      if (gate.status !== 'pass') {
        console.error(`[remake] ${item} not checked/passed:`, gate.status, gate.reason)
        ledger.push({ item, attempt: 0, creditsMicro: '0', outcome: 'blocked' })
        return
      }
      const slot = 2 + k
      const g = await deps.generateStill({ prompt, aspectRatio: '3:4', engine: 'gemini', skipAvatarExpansion: true, title: `Remake character ${k + 1}` }, exec(slot), slot)
      if (g.fileId) fileIds[String(c.i)] = g.fileId
      else console.error(`[remake] ${item} not made:`, g.refusalReason ?? (g.insufficientCredits ? 'credits' : 'unknown'))
      ledger.push({ item, attempt: 0, creditsMicro: g.creditsUsedMicro ?? '0', outcome: g.fileId ? 'kept' : 'failed' })
    } catch (err) {
      console.error(`[remake] ${item} failed:`, err instanceof Error ? err.message : String(err))
    }
  }))
  return { fileIds, ledger }
}

// The chosen person's reference sheet (the TVC continuity bible, minus costume) leads every still and is the
// face check's reference (face consistency is hard). Gated like every paid call; a sheet that can't be
// made never ends the run: the stills fall back to the cropped portrait.
async function referenceSheet(portraitId: string, a: { tenantId: string }, deps: RemakeDeps, exec: ReturnType<ReturnType<typeof execFor>>, styling = ''): Promise<{ fileId: string | null; ledger: LedgerEntry[] }> {
  try {
    // The person sheet carries the reel's styling (user, 2026-10-16: "a sheet with open hair"), so every
    // still starts from the hair and jewellery the reel has.
    const prompt = styling ? `${REFERENCE_SHEET_PROMPT} Styling in every panel: ${styling}.` : REFERENCE_SHEET_PROMPT
    const gate = await deps.promptGate({ prompt, planLine: `reference sheet of the chosen person; ${CAST_BY_IMAGE}`, look: {}, startFrameObjects: [], keyMoments: [], tenantId: a.tenantId })
    if (gate.status !== 'pass') {
      console.error('[remake] reference sheet not checked/passed:', gate.status, gate.reason)
      return { fileId: null, ledger: [{ item: 'reference sheet', attempt: 0, creditsMicro: '0', outcome: 'blocked' }] }
    }
    const g = await deps.generateStill({ prompt, aspectRatio: '3:4', imageSize: '2K', referenceFileIds: [portraitId], engine: 'gemini', skipAvatarExpansion: true, title: 'Remake reference sheet' }, exec, 1)
    if (!g.fileId) console.error('[remake] reference sheet not made:', g.refusalReason ?? (g.insufficientCredits ? 'credits' : 'unknown'))
    return { fileId: g.fileId ?? null, ledger: [{ item: 'reference sheet', attempt: 0, creditsMicro: g.creditsUsedMicro ?? '0', outcome: g.fileId ? 'kept' : 'failed' }] }
  } catch (err) {
    console.error('[remake] reference sheet failed:', err instanceof Error ? err.message : String(err))
    return { fileId: null, ledger: [] }
  }
}

/** Each continuing part's start still is the previous look's end still (same file, no tries: it
 *  was paid for once, on the previous part). */
export function continueParts(looks: RemakeLook[], stills: StillResult[]): StillResult[] {
  const out = [...stills]
  const ordered = [...looks].sort((a, b) => a.startS - b.startS)
  ordered.forEach((look, i) => {
    if (!look.continues || i === 0) return
    const prev = out.find((s) => s.look === ordered[i - 1].n && s.kind === 'end')
    const start: StillResult = prev ? { look: look.n, kind: 'start', fileId: prev.fileId, status: prev.status, reasons: prev.reasons } : { look: look.n, kind: 'start', fileId: null, status: 'failed', reasons: ['the part before it has no end still'] }
    out.push(start)
  })
  return out
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
      const id = await deps.upload(a.idToken, generatedFileKey(a.conversationId, `remake ${runId} look ${n} ${kind} guide`, 'jpg'), `Remake look ${n} ${kind} guide.jpg`, deps.readFile(out), 'image/jpeg')
      return id ? { id, path: out } : null
    }
    // Identity: the reference sheet when there is one, else the cropped portrait.
    const portraitId = (inputData.referenceSheetFileId as string | null | undefined) ?? inputData.portraitFileId
    const portrait = portraitId ? { fileId: portraitId, img: await deps.fetchImage(portraitId, a.idToken) } : null
    const product = brand.productPhotoFileId && usesProduct(plan, brand) ? brand.productPhotoFileId : null
    const ctx: StillCtx = { tenantId: a.tenantId, idToken: a.idToken, scopeId: a.scopeId, runId, conversationId: a.conversationId, exec: execFor(requestContext as Rc, runId, a.idToken), portrait }
    ctx.outOfCredits = () => outOfCredits
    // The anchor: the first kept person still, passed to the rest (same person, same light). Not when a
    // product photo needs the third reference slot (the product must show exactly).
    let anchor: string | null = null
    // The anchor's own pose guide: later stills match its room only where the original's frames do too.
    let anchorGuide: string | null = null
    // Once credits run out, the remaining stills stop before any guide, gate or call (M3).
    let outOfCredits = false
    type Made = { result: StillResult; ledger: LedgerEntry[] }
    const noCredits = (look: number, kind: 'start' | 'end'): Made => ({ result: { look, kind, fileId: null, status: 'failed' as const, reasons: ['not enough credits'] }, ledger: [] })
    // Pose-guide frames show the original person: deleted from the user's files after use (M4).
    const guideIds: string[] = []
    const guides = new Map<string, { id: string; path: string } | null>()
    const guideFor = async (look: RemakeLook, kind: 'start' | 'end') => {
      const key = `${look.n}-${kind}`
      if (!guides.has(key)) {
        const g = await guide(look.n, kind, kind === 'start' ? look.guideStartS : look.guideEndS)
        if (g) guideIds.push(g.id)
        guides.set(key, g)
      }
      return guides.get(key)!
    }
    // Other characters in view: their portraits go after the still's own references, named by image number.
    const charIds = (inputData.characterFileIds ?? {}) as Record<string, string>
    const charsIn = (look: RemakeLook, kind: 'start' | 'end') => charactersAt(plan, stillTime(look, kind)).filter((c) => charIds[String(c.i)])
    const withCharacters = (refs: string[], chars: Array<{ i: number }>): { references: string[]; images: CharacterImages } => {
      const images: CharacterImages = new Map()
      const references = [...refs]
      for (const c of chars) { references.push(charIds[String(c.i)]); images.set(c.i, references.length) }
      return { references, images }
    }
    // The person for a look: its styled picture when the look has a styling, else the base person.
    const stylingIds = (inputData.stylingFileIds ?? {}) as Record<string, string>
    const personFor = (look: RemakeLook): string | null => stylingIds[String(refOf(look))] ?? portrait?.fileId ?? null
    // An edited still (tools/nextShot): the base photo first, the original's frame second; the face check
    // still compares against the chosen person.
    type Base = { fileId: string; change: ShotChange }
    const jobFor = (look: RemakeLook, kind: 'start' | 'end', g: string, base?: Base): StillJob => {
      const person = personIn(look)
      const chars = person ? charsIn(look, kind) : []
      if (base) {
        const { references, images } = withCharacters([base.fileId, g], chars)
        const extra = [...images.entries()].map(([i, n]) => `the ${plan.reference.characters?.[i]?.who ?? 'other person'} is the person in image ${n}`).join('; ')
        const change = { ...base.change, ...(extra ? { extra } : {}) }
        const prompt = editShotPrompt(change)
        return { look, kind, prompt, references, aspectRatio: plan.aspectRatio, guide: g, faceRef: base.fileId, props: propsAt(plan, stillTime(look, kind)), gate: { prompt, planLine: editShotGateLine(change, `looks[${refOf(look)}]`), look: {}, startFrameObjects: [], keyMoments: [] }, ...(chars.length ? { people: Math.max(look.people ?? 1, 1 + chars.length) } : {}) }
      }
      const who = personFor(look)
      const { references, images } = withCharacters([...(person && who ? [who] : []), g, ...(product ? [product] : person && anchor ? [anchor] : [])], chars)
      const prompt = stillPrompt(plan, look, kind, brand, !!product, images)
      const room = person && anchor && anchorGuide && !product ? { room: { fileId: anchor, guides: [anchorGuide, g] as [string, string] } } : {}
      return { look, kind, prompt, references, aspectRatio: plan.aspectRatio, guide: g, props: propsAt(plan, stillTime(look, kind)), gate: stillGateInput(plan, look, kind, prompt, images), ...(chars.length ? { people: Math.max(look.people ?? 1, 1 + chars.length) } : {}), ...room }
    }
    const single = async (look: RemakeLook, kind: 'start' | 'end', firstTry?: { fileId: string; creditsMicro: string }, base?: Base): Promise<Made> => {
      // Never paid: a look whose people were not measured (spec §8a).
      if (!look.measuredPeople) return { result: { look: look.n, kind, fileId: null, status: 'blocked', reasons: ['this part of the video couldn’t be measured, so its still wasn’t made'] }, ledger: [] }
      // One still failing never ends the run: earlier stills are paid for and must reach the ledger and the preview.
      if (outOfCredits && !firstTry) return noCredits(look.n, kind)
      try {
        const g = await guideFor(look, kind)
        if (outOfCredits && !firstTry) return noCredits(look.n, kind)
        if (!g) return { result: { look: look.n, kind, fileId: null, status: 'blocked', reasons: ['the pose guide could not be saved'] }, ledger: [] }
        const made = await makeStill(jobFor(look, kind, g.id, base), ctx, deps, firstTry)
        if (made.result.reasons.some((r) => r.includes('not enough credits'))) outOfCredits = true
        return made
      } catch (err) {
        console.error(`[remake] look ${look.n} ${kind} still failed:`, err instanceof Error ? err.message : String(err))
        return { result: { look: look.n, kind, fileId: null, status: 'failed', reasons: ['this still could not be made this time'] }, ledger: [] }
      }
    }
    // A board: 2-3 stills of one outfit look made as one image, cut apart free, each photo then checked
    // and retried like a single still. Anything short of usable photos falls back to single stills.
    let boards = 0
    const board = async (unit: Item[]): Promise<Made[]> => {
      const singles = () => Promise.all(unit.map((u) => single(u.look, u.kind)))
      if (outOfCredits || !portrait || unit.some((u) => !u.look.measuredPeople)) return singles()
      const i = boards++
      const label = `${unit.map((u) => `look ${u.look.n} ${u.kind}`).join(', ')} stills (one image)`
      let made: Awaited<ReturnType<RemakeDeps['generateStill']>> | null = null
      try {
        const gs = await Promise.all(unit.map((u) => guideFor(u.look, u.kind)))
        if (gs.some((g) => !g)) return singles()
        const stripPath = join(dir, `board-${i}-guides.jpg`)
        await deps.ffmpeg([...gs.flatMap((g) => ['-i', g!.path]), '-filter_complex', `${gs.map((_, k) => `[${k}]scale=540:960,setsar=1[v${k}]`).join(';')};${gs.map((_, k) => `[v${k}]`).join('')}hstack=${gs.length}`, '-q:v', '2', stripPath])
        const strip = await deps.upload(a.idToken, generatedFileKey(a.conversationId, `remake ${runId} board ${i} guides`, 'jpg'), `Remake board ${i + 1} guides.jpg`, deps.readFile(stripPath), 'image/jpeg')
        if (!strip) return singles()
        guideIds.push(strip)
        const chars = [...new Map(unit.flatMap((u) => charsIn(u.look, u.kind)).map((c) => [c.i, c])).values()]
        const { references, images } = withCharacters([personFor(unit[0].look) ?? portrait.fileId, strip], chars)
        const prompt = boardPrompt(plan, unit, images)
        const gate = await deps.promptGate({ ...boardGateInput(plan, unit, prompt, images), tenantId: a.tenantId })
        if (gate.status !== 'pass') {
          console.error(`[remake] board of ${label} stopped by the prompt check (single stills instead): ${gate.reason}`)
          return singles()
        }
        if (outOfCredits) return singles()
        const slot = BOARD_SLOT + i
        made = await deps.generateStill({ prompt, aspectRatio: boardAspect(unit.length), imageSize: '2K', referenceFileIds: references, engine: 'gemini', skipAvatarExpansion: true, title: `Remake board ${i + 1}` }, ctx.exec(slot), slot)
        if (!made.fileId) {
          if (made.insufficientCredits) outOfCredits = true
          else console.error(`[remake] board of ${label} not made: ${made.refusalReason ?? 'unknown'}`)
          const spent = made.creditsUsedMicro ?? '0'
          const rest = await singles()
          return spent === '0' ? rest : [{ ...rest[0], ledger: [{ item: label, attempt: 0, creditsMicro: spent, outcome: 'failed' }, ...rest[0].ledger] }, ...rest.slice(1)]
        }
        const panels = await deps.cutBoard(made.fileId, unit.length, plan.aspectRatio, { idToken: a.idToken, scopeId: a.scopeId, tenantId: a.tenantId, runId, conversationId: a.conversationId }).catch((err) => {
          console.error(`[remake] board of ${label} could not be cut:`, err instanceof Error ? err.message : String(err))
          return null
        })
        const spent = made.creditsUsedMicro ?? '0'
        if (!panels || panels.length !== unit.length) {
          const rest = await singles()
          return [{ ...rest[0], ledger: [{ item: label, attempt: 0, creditsMicro: spent, outcome: 'failed' }, ...rest[0].ledger] }, ...rest.slice(1)]
        }
        const share = String(BigInt(spent) / BigInt(unit.length))
        const out = await Promise.all(unit.map((u, k) => single(u.look, u.kind, { fileId: panels[k], creditsMicro: share })))
        const kept = out.some((o) => usableStill(o.result))
        return [{ ...out[0], ledger: [{ item: label, attempt: 0, creditsMicro: spent, outcome: kept ? 'kept' : 'failed' }, ...out[0].ledger] }, ...out.slice(1)]
      } catch (err) {
        console.error(`[remake] board of ${label} failed (single stills instead):`, err instanceof Error ? err.message : String(err))
        return made?.fileId ? singles().then((rest) => [{ ...rest[0], ledger: [{ item: label, attempt: 0, creditsMicro: made!.creditsUsedMicro ?? '0', outcome: 'failed' as const }, ...rest[0].ledger] }, ...rest.slice(1)]) : singles()
      }
    }
    type Item = { look: RemakeLook; kind: 'start' | 'end'; person: boolean }
    const items: Item[] = plan.looks.flatMap((look) =>
      // A continuing part of a long shot starts from the previous part's end still (never paid twice).
      ((look.needsEndStill ? ['start', 'end'] : ['start']) as Array<'start' | 'end'>).filter((k) => !(k === 'start' && look.continues)).map((kind) => ({ look, kind, person: personIn(look) })))
    const units = boardUnits(items, { aspectRatio: plan.aspectRatio, product: !!product })
    const runUnit = (u: Item[]): Promise<Made[]> => (u.length > 1 ? board(u) : single(u[0].look, u[0].kind).then((m) => [m]))
    const byItem = new Map<Item, Made>()
    // The v12 way (tools/nextShot): person stills in one place of the original are an edit chain. Each
    // place's first start still is fresh; every other start there is an edit of it (outfit, styling, pose
    // from its frame); every end still is an edit of its own start (pose only). Not with a product photo
    // (it needs its reference slot and a fresh draw to show exactly).
    const runChain = async () => {
      const starts = items.filter((it) => it.person && it.kind === 'start')
      // A frame that can't be saved or read only means that still is drawn fresh (its own failure is
      // reported by single(), which tries the guide again); it never stops the run.
      const frames = await Promise.all(starts.map(async (it) => {
        try { const g = await guideFor(it.look, 'start'); return g ? await deps.fetchImage(g.id, a.idToken) : null } catch { return null }
      }))
      let groups = starts.map((_, i) => i)
      if (frames.every(Boolean)) {
        try { groups = await placeGroups(deps.ask(a.tenantId), frames as Img[], deps.sameSetting) } catch (err) { console.error('[remake] place check failed (each still drawn fresh):', err instanceof Error ? err.message : String(err)) }
      }
      const firstOf = new Map<number, Item>()
      starts.forEach((it, i) => { if (!firstOf.has(groups[i])) firstOf.set(groups[i], it) })
      const firsts = [...firstOf.values()]
      const fm = await Promise.all(firsts.map((it) => single(it.look, it.kind)))
      firsts.forEach((it, k) => byItem.set(it, fm[k]))
      const others = starts.filter((it) => !firsts.includes(it))
      const om = await Promise.all(others.map((it) => {
        const first = firstOf.get(groups[starts.indexOf(it)])!
        const fileId = usableStill(byItem.get(first)!.result)
        const styling = stylingOf(plan, it.look)
        const change: ShotChange = { poseFromFrame: true, ...(outfitOf(plan, it.look) !== outfitOf(plan, first.look) ? { outfit: outfitOf(plan, it.look) } : {}), ...(styling && styling !== stylingOf(plan, first.look) ? { styling } : {}) }
        return single(it.look, it.kind, undefined, fileId ? { fileId, change } : undefined)
      }))
      others.forEach((it, k) => byItem.set(it, om[k]))
      // End stills: an edit of the look's own start (a continuing part starts from the previous part's end).
      const ordered = [...plan.looks].sort((x, y) => x.startS - y.startS)
      const startOf = (look: RemakeLook): string | null => {
        const own = items.find((it) => it.look === look && it.kind === 'start')
        if (own) return byItem.has(own) ? usableStill(byItem.get(own)!.result) : null
        const prev = ordered[ordered.indexOf(look) - 1]
        const prevEnd = prev && items.find((it) => it.look === prev && it.kind === 'end')
        return prevEnd && byItem.has(prevEnd) ? usableStill(byItem.get(prevEnd)!.result) : null
      }
      const endOf = async (look: RemakeLook) => {
        const end = items.find((it) => it.person && it.look === look && it.kind === 'end')
        if (!end) return
        const fileId = startOf(look)
        byItem.set(end, await single(look, 'end', undefined, fileId ? { fileId, change: { poseFromFrame: true } } : undefined))
      }
      // Parallel where a look has its own start; a continuing part waits for the part before it.
      await Promise.all(ordered.filter((l) => !l.continues).map(endOf))
      for (const look of ordered.filter((l) => l.continues)) await endOf(look)
      const rest = items.filter((it) => !byItem.has(it))
      const rm = await Promise.all(rest.map((it) => single(it.look, it.kind)))
      rest.forEach((it, k) => byItem.set(it, rm[k]))
    }
    // Back in plan order.
    const finish = () => {
      const done = items.map((it) => byItem.get(it)!)
      return { ...inputData, stills: continueParts(plan.looks, done.map((d) => d.result)), ledger: [...(inputData.ledger as LedgerEntry[]), ...done.flatMap((d) => d.ledger)] }
    }
    try {
      if (!product && items.some((it) => it.person)) { await runChain(); return finish() }
      const first = units.findIndex((u) => u.some((j) => j.person))
      if (first >= 0) {
        const firstDone = await runUnit(units[first])
        units[first].forEach((it, k) => byItem.set(it, firstDone[k]))
        if (!product) {
          const k = firstDone.findIndex((d, j) => units[first][j].person && usableStill(d.result))
          anchor = k >= 0 ? usableStill(firstDone[k].result) : null
          anchorGuide = k >= 0 ? guides.get(`${units[first][k].look.n}-${units[first][k].kind}`)?.id ?? null : null
        }
      }
      const rest = units.filter((_, i) => i !== first)
      for (let i = 0; i < rest.length; i += MAX_PARALLEL) {
        const batch = rest.slice(i, i + MAX_PARALLEL)
        const res = await Promise.all(batch.map(runUnit))
        batch.forEach((u, k) => u.forEach((it, m) => byItem.set(it, res[k][m])))
      }
    } finally {
      deps.removeDir(dir)
      await Promise.all(guideIds.map((id) => deps.deleteFile(a.idToken, id)))
    }
    return finish()
  },
})

const previewed = stilled.extend({ previewFileId: z.string().nullable(), stop: z.boolean() })
// A fix the user asks for on one photo at the preview (fan run real6: the dupatta over her head, and the
// preview could only be approved or stopped). Slots 800+, two per fix (the edit and its one retry).
const FIX_SLOT = 800
const fixSchema = z.object({ look: z.number().int(), kind: z.enum(['start', 'end']), change: z.string() })
const previewStep = createStep({
  id: 'preview', inputSchema: stilled, outputSchema: previewed,
  // stills/ledger: the photos as they are now, after any fix (the step's input keeps the first ones)
  suspendSchema: z.object({ stage: z.literal('preview_review'), previewFileId: z.string().nullable(), stills: z.array(any), ledger: z.array(any).optional(), summary: any, clipsEstimate: any.optional(), cantAnimate: z.string().optional(), error: z.string().optional() }),
  resumeSchema: z.object({ decision: z.enum(['approve', 'stop', 'fix']), fixes: z.array(fixSchema).optional() }),
  execute: async ({ inputData, requestContext, runId, resumeData, suspendData, suspend }) => {
    const a = access(requestContext as Rc, inputData.tenantId, runId)
    const deps = remakeDeps()
    const plan = inputData.plan as RemakePlan
    let stills = (suspendData?.stills as StillResult[] | undefined) ?? inputData.stills as StillResult[]
    let ledger = (suspendData?.ledger as LedgerEntry[] | undefined) ?? inputData.ledger as LedgerEntry[]
    // Square: the video models make only 9:16 or 16:9 (Review Focus 2).
    // Nothing to animate when no part has a usable start still (live run 08466630 went on to
    // an all-grey "finished" video).
    const cantAnimateOf = (all: StillResult[]) => plan.aspectRatio === '1:1' ? 'Square videos can be previewed but not animated yet.'
      : !all.some((s) => s.kind === 'start' && !!usableStill(s)) ? 'None of the stills could be made, so there is nothing to animate yet. Change the plan and start the remake again.' : undefined
    if (resumeData && resumeData.decision !== 'fix') {
      return { ...inputData, stills, ledger, previewFileId: (suspendData?.previewFileId as string | null | undefined) ?? null, stop: resumeData.decision === 'stop' || !!cantAnimateOf(stills) }
    }
    let error: string | undefined
    if (resumeData?.decision === 'fix') {
      const fixed = await fixPhotos(plan, stills, (resumeData.fixes ?? []).filter((f) => f.change.trim()), ledger, inputData, a, requestContext as Rc, runId)
      stills = fixed.stills
      ledger = [...ledger, ...fixed.ledger]
      error = fixed.error
    }
    const cantAnimate = cantAnimateOf(stills)
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
    return await suspend({ stage: 'preview_review', previewFileId, stills, ledger, summary: ledgerSummary(ledger), ...(clipsEstimate ? { clipsEstimate } : {}), ...(cantAnimate ? { cantAnimate } : {}), ...(error ? { error } : {}) })
  },
})

// Each fix is an EDIT of the photo the user saw (edit, never regenerate), checked like any still with that
// photo as the face to keep. A fix that can't be made leaves the photo as it was.
async function fixPhotos(plan: RemakePlan, stills: StillResult[], fixes: Array<z.infer<typeof fixSchema>>, ledger: LedgerEntry[], inputData: { referenceSheetFileId?: string | null; portraitFileId?: string | null; tenantId: string }, a: ReturnType<typeof access>, rc: Rc, runId: string): Promise<{ stills: StillResult[]; ledger: LedgerEntry[]; error?: string }> {
  const deps = remakeDeps()
  const portraitId = inputData.referenceSheetFileId ?? inputData.portraitFileId
  const ctx: StillCtx = { tenantId: a.tenantId, idToken: a.idToken, scopeId: a.scopeId, runId, conversationId: a.conversationId, exec: execFor(rc, runId, a.idToken), portrait: portraitId ? { fileId: portraitId, img: await deps.fetchImage(portraitId, a.idToken) } : null }
  const done = ledger.filter((l) => / still change$/.test(l.item) && l.attempt === 0).length
  const out = [...stills]
  const spent: LedgerEntry[] = []
  const missed: string[] = []
  await Promise.all(fixes.map(async (f, k) => {
    const look = plan.looks.find((l) => l.n === f.look)
    const still = stills.find((s) => s.look === f.look && s.kind === f.kind)
    const old = still && usableStill(still)
    if (!look || !old) { missed.push(`look ${f.look} ${f.kind}`); return }
    const change = f.change.trim()
    // A user's change is often the outfit or the pose itself, so only the person and the scene are kept
    // (editPrompt's "keep the pose, outfit" kept the veil and the straight knees word for word, fan run real9).
    const prompt = `Edit the first image. Change only this: ${change}. Keep the same person and face, the room, the light and the camera framing; everything the change does not name stays as it is. No text or logos.`
    const job: StillJob = { look, kind: f.kind, prompt, references: [old], aspectRatio: plan.aspectRatio, faceRef: old, slot: FIX_SLOT + 2 * (done + k),
      gate: { prompt, planLine: `edit the user asked for on a photo they already saw (the first image): ${change}; everything else is kept from the first image`, look: {}, startFrameObjects: [], keyMoments: [] } }
    try {
      const made = await makeStill(job, ctx, deps)
      spent.push(...made.ledger.map((l) => ({ ...l, item: `look ${f.look} ${f.kind} still change` })))
      const now = usableStill(made.result)
      if (!now || made.result.status === 'failed' || made.result.status === 'blocked') { missed.push(`look ${f.look} ${f.kind}${made.result.reasons.length ? ` (${made.result.reasons.join('; ')})` : ''}`); return }
      // A continuing part starts from this same photo: it changes with it.
      out.forEach((s, i) => { if (s.fileId === old) out[i] = { ...made.result, look: s.look, kind: s.kind } })
    } catch (err) {
      console.error(`[remake] look ${f.look} ${f.kind} fix failed:`, err instanceof Error ? err.message : String(err))
      missed.push(`look ${f.look} ${f.kind}`)
    }
  }))
  return { stills: out, ledger: spent, ...(missed.length ? { error: `these photos could not be changed this time and are as they were: ${missed.join(', ')}` } : {}) }
}

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
      // Each object in view is counted per frame against the approved start photo (two remotes, 2026-10-17).
      check: async (clipPath: string, spec: ClipSpec, engine: 'veo' | 'omni') => {
        const props = [...new Set([spec.look.startS, (spec.look.startS + spec.look.endS) / 2, spec.look.endS - 0.01].flatMap((t) => propsAt(plan, t)))]
        const startImage = spec.start && props.length ? await deps.fetchImage(spec.start, a.idToken).catch(() => undefined) : undefined
        return checkClip({ clipPath, seconds: spec.frames / CLIP_FPS, look: spec.look, portrait, tenantId: a.tenantId, checkEnd: engine === 'veo', startImage, props }, { poseClip: deps.poseClip, sample: deps.sample, gate: runGate, ask: deps.ask(a.tenantId) })
      },
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
      let video = await deps.joinSegments(parts, join(work, 'joined.mp4'), size)
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
