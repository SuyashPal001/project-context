import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { uploadFileWithKey } from '../../persistence.js'
import { fetchPresignedUrl } from './mediaCache.js'
import { EXTRACTED_FRAME_KEY_MARKER } from './extractFrame.js'
import { detectCutTimes } from './detectCuts.js'
import { computeCreditPlan, priceFromRates, readBalanceForTenant } from './checkCreditPlan.js'
import { recordOnPlan, sliceTvcPlan, tvcCreditSteps, tvcPlanSchema, validateTvcPlan, jingleErrors, legalTimings, type TvcPlan } from './tvcPlan.js'
import { draftCutdown, inheritFromMaster, rebuildCutdown } from './tvcCutdown.js'
import { stillPassedCheck } from './checkStill.js'
import { LOGO_IS_PRODUCT_PHOTO, LOGO_NOT_IMAGE, LOGO_NOT_RASTER, LOGO_UNCHECKED, isSvgFile } from './packshotMarks.js'

// The TVC ad's plan lives in ONE file whose id never changes: it is always
// re-uploaded to the same storage key, and /files/:id/confirm keeps the
// original row (persistence.ts uploadFileWithKey). Delegations then carry only
// "TVC plan: <id>" and a step — the plan itself never rides in a prompt.
export interface SavedPlan { version: 1; storageKey: string; plan: TvcPlan }

export interface ProductPhotoInfo { mimeType: string; pathname: string }

// Task 1 + Task 2 review fix: ONE presigned GET per check, not two — this
// single URL resolution feeds both the mime-type check (Task 1) and the
// extracted-frame marker check (Task 2) below. The `x-amz-checksum-mode`
// query param still has to be stripped before the GET (same fix as `load`
// above, analyzeImage.ts, extractFrame.ts, mediaCache.ts, productDescribe.ts)
// or a real product photo 400s and gets refused as PRODUCT_PHOTO_UNCHECKED
// instead of being read. `pathname` is read off the URL before that
// mutation — query params never touch the path. Extracted so it can be
// unit-tested with a fake fetch, independent of the rest of planTvc's
// execute wiring.
export async function resolveProductPhotoInfo(fileId: string, idToken: string): Promise<ProductPhotoInfo> {
  const url = new URL(await fetchPresignedUrl(fileId, idToken))
  const pathname = url.pathname
  url.searchParams.delete('x-amz-checksum-mode')
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`product photo fetch failed: HTTP ${res.status}`)
  const mimeType = res.headers.get('content-type') ?? 'application/octet-stream'
  // Only the header is needed — cancel the body so the image isn't
  // downloaded for nothing (the presigned URL is signed for GET, so this
  // stays a GET rather than switching to HEAD).
  await res.body?.cancel()
  return { mimeType, pathname }
}

// Task 2 review fix: anchored on a UUID-shaped segment, not a bare substring
// search. generatedFileKey trims a trailing hyphen, so a title that slugs to
// nothing (Hindi, punctuation-only) produces "<uuid>-extract-frame.jpg" with
// no second hyphen after the marker — a plain `includes('-extract-frame-')`
// missed that case. Anchoring on the 36-char uuid immediately before the
// marker also stops false positives from an unrelated file whose name merely
// contains the phrase, e.g. a generated still titled "Bubbli extract frame
// shot" (key "<uuid>-bubbli-extract-frame-shot.jpg") or a user upload named
// "my-extract-frame-photo.jpg" — neither has 36 hex/hyphen characters
// immediately before "-extract-frame".
const EXTRACTED_FRAME_PATH_RE = new RegExp(`/[0-9a-f-]{36}-${EXTRACTED_FRAME_KEY_MARKER}[-.]`, 'i')

// Task 2: whether productPhotoFileId is itself a frame extract_frame pulled
// from a video (see extractFrame.ts's EXTRACTED_FRAME_KEY_MARKER) rather
// than a real photo of the product — a live run had Director do exactly
// this with the reference ad's last frame.
export function isExtractedFramePath(pathname: string): boolean {
  return EXTRACTED_FRAME_PATH_RE.test(pathname)
}

// F1: some browser uploads reach S3 with a generic mime type instead of the
// real one (apps/web/lib/assetType.ts:7-9 falls back to these same strings).
// When that happens, the photo is still accepted if its storage pathname
// ends in a real image extension — otherwise a real product photo was being
// refused as PRODUCT_PHOTO_NOT_IMAGE purely because the browser mislabeled
// it on upload.
const OCTET_STREAM_MIMES = new Set(['application/octet-stream', 'binary/octet-stream', ''])
const IMAGE_EXTENSION_RE = /\.(jpe?g|png|webp|avif|heic)$/i

function looksLikeProductPhoto(mimeType: string, pathname: string): boolean {
  if (mimeType.startsWith('image/')) return true
  return OCTET_STREAM_MIMES.has(mimeType.toLowerCase()) && IMAGE_EXTENSION_RE.test(pathname)
}

// Review fix: the logo is a narrower raster set than the product photo
// (composite_end_card only ever lays PNG, JPEG or WebP onto the packshot) —
// a HEIC or GIF logo passed looksLikeProductPhoto's wider check and only
// failed later, at the paid end-card step. SVG is its own LOGO_NOT_RASTER
// refusal via isSvgFile, checked before this.
const LOGO_IMAGE_MIME_RE = /^image\/(png|jpeg|webp)$/i
const LOGO_IMAGE_EXTENSION_RE = /\.(jpe?g|png|webp)$/i
function looksLikeLogoImage(mimeType: string, pathname: string): boolean {
  if (LOGO_IMAGE_MIME_RE.test(mimeType)) return true
  return OCTET_STREAM_MIMES.has(mimeType.toLowerCase()) && LOGO_IMAGE_EXTENSION_RE.test(pathname)
}

// plan_tvc never takes a threshold from Director — only the detect_cuts tool
// does (see detectCuts.ts's cache-poisoning note). Always the fixed default
// that matched the 2026-10-05 reference ad, so a plan's check is always
// against the same cut count the real file produces.
const REFERENCE_CUT_THRESHOLD = 0.25

export interface PlanTvcDeps {
  load: (planFileId: string) => Promise<SavedPlan>
  save: (doc: SavedPlan) => Promise<string | null>
  price: (plan: TvcPlan) => Promise<{ fullCostCredits: number; shortfallCredits: number }>
  newKey: () => string
  stillChecked: (stillFileId: string) => boolean | Promise<boolean>
  // P6 (Task 4): the only source of truth for a reference ad's cut times.
  // Director can set brief.reference.videoFileId but never cutTimes itself —
  // check always overwrites cutTimes with what this returns, so a plan can
  // never be made to pass by editing the numbers.
  detectCutTimes: (videoFileId: string) => Promise<{ cutTimes: number[]; durationSeconds: number }>
  // Task 1 + Task 2 (merged on review): the product photo's real mime type
  // AND its key's path, both read from the file itself in one lookup —
  // never trusted from Director. A live run passed the reference video's
  // fileId as productPhotoFileId (every still then failed GENERATION_FAILED),
  // and a separate live run had Director extract the reference's last frame
  // and use it as "the product". Throws if the file can't be read (check
  // refuses rather than passing silently).
  productPhotoInfo: (fileId: string) => Promise<ProductPhotoInfo>
  // F4: set from requestContext's tvcReferenceVideoFileId (hooks.ts),
  // undefined when Olmo's delegation prompt carried no "Reference video:" —
  // the ordinary, reference-free ad flow.
  expectedReferenceVideoFileId?: string
}

export const planTvcInputSchema = z.object({
  action: z.enum(['check', 'get', 'record', 'cutdown']).describe('check: validate and save the plan; get: read one slice; record: attach finished stills or clips to their shots, or the finish\'s narration, song and jingle to the plan; cutdown: a draft shorter version of a finished ad (planFileId = the original, lengthSeconds), free and not saved'),
  plan: tvcPlanSchema.optional().describe('check only: the full plan'),
  planFileId: z.string().optional().describe('The TVC plan id. Required for get and record; pass it on a re-check so the plan keeps its id'),
  slice: z.string().optional().describe('get only: "brief", "finish" or "shots a-b", e.g. "shots 4-6"'),
  shot: z.number().int().min(1).optional().describe('record only: the shot number'),
  stillFileId: z.string().optional().describe('record only: the shot\'s approved still'),
  clipFileId: z.string().optional().describe('record only: the shot\'s checked, trimmed clip'),
  records: z.array(z.object({
    shot: z.number().int().min(1),
    stillFileId: z.string().optional(),
    clipFileId: z.string().optional(),
    keptByUser: z.boolean().optional().describe('The user chose to keep this still although its check failed'),
  })).optional().describe('record only: every still or clip a step made, in one call'),
  narrationFileIds: z.array(z.string()).optional().describe('record only: the finish\'s narration, one per voiceover block, in order'),
  songFileId: z.string().optional().describe('record only: the finish\'s music bed'),
  jingleFileId: z.string().optional().describe('record only: generate_jingle\'s fileId (the full sung clip)'),
  signoffFileId: z.string().optional().describe('record only: generate_jingle\'s signoffFileId'),
  signoffSeconds: z.number().positive().optional().describe('record only: generate_jingle\'s signoffSeconds'),
  keptByUser: z.boolean().optional().describe('record only, single-shot form: the user chose to keep this still although its check failed'),
  lengthSeconds: z.number().refine((n) => n === 6 || n === 15 || n === 20, { message: 'lengthSeconds must be 6, 15 or 20' }).optional().describe('cutdown only: the shorter length, 6, 15 or 20 seconds, shorter than the original'),
  keepShots: z.array(z.number().int().min(1)).optional().describe('cutdown only: the original shot numbers to keep instead of the ones plan_tvc picks; the packshot is always kept'),
})
export type PlanTvcInput = z.infer<typeof planTvcInputSchema>

export interface PlanTvcOutput {
  planFileId?: string
  errors?: string[]
  warnings?: string[]
  costCredits?: number
  shortfallCredits?: number
  slice?: string
  refused?: boolean
  refusalReason?: string
}

// F4: compared field by field, not with JSON.stringify — a jingle rebuilt
// with the same fields in a different key order must still count as the same.
function jingleFieldsEqual(a: TvcPlan['brief']['jingle'], b: TvcPlan['brief']['jingle']): boolean {
  if (!a || !b) return a === b
  if (a.line !== b.line || a.style !== b.style || a.language !== b.language) return false
  const al = a.lyrics ?? [], bl = b.lyrics ?? []
  return al.length === bl.length && al.every((l, i) => l === bl[i])
}

// Recorded files survive a re-check while what they were made for is the same.
// R2 (animatic): a still survives any edit that does not change the picture
// (length, order, text, motion, price), matched by what the shot shows, so a
// timing tweak after the animatic never forces paid new stills. A clip also
// depends on the shot's place, length and continuation (generateSecondsFor
// and the trims), so it survives only when those are the same too.
// R7: the narration survives while every block's words and the voice are the
// same (where a block starts does not change the audio; the mix places it).
// Whatever recorded audio is dropped is returned, so check can warn before a
// paid remake.
function carryOver(previous: TvcPlan, next: TvcPlan): { plan: TvcPlan; dropped: string[] } {
  const out = structuredClone(next)
  const dropped: string[] = []
  const texts = (p: TvcPlan) => JSON.stringify(p.voiceover.map((b) => b.text))
  const sameVoiceover = texts(previous) === texts(next) && previous.brief.voiceId === next.brief.voiceId
  out.narrationFileIds = sameVoiceover ? previous.narrationFileIds : undefined
  if (previous.narrationFileIds && !out.narrationFileIds) dropped.push('NARRATION_REMAKE: the voiceover changed, so its narration will be made again (paid)')
  const sameMusic = previous.brief.tier === next.brief.tier && previous.brief.category === next.brief.category
  out.songFileId = sameMusic ? previous.songFileId : undefined
  if (previous.songFileId && !out.songFileId) dropped.push('MUSIC_REMAKE: the tier or category changed, so the music bed will be made again (paid)')
  // The recorded jingle survives while the jingle asked for is the same and
  // still fits the (possibly changed) voiceover; otherwise it must be re-made.
  delete out.jingleFileId; delete out.signoffFileId; delete out.signoffSeconds
  const sameJingle = !!next.brief.jingle && jingleFieldsEqual(previous.brief.jingle, next.brief.jingle)
  if (sameJingle && previous.signoffSeconds !== undefined && jingleErrors(out, previous.signoffSeconds).length === 0) {
    out.jingleFileId = previous.jingleFileId
    out.signoffFileId = previous.signoffFileId
    out.signoffSeconds = previous.signoffSeconds
  } else if (sameJingle && previous.signoffSeconds !== undefined) {
    dropped.push('JINGLE_REMAKE: the sung sign-off no longer fits the new timing and will be made again (paid)')
  }
  const pictureKey = (s: TvcPlan['shots'][number]) => JSON.stringify({
    ...s, n: undefined, durationSeconds: undefined, text: undefined, motion: undefined, price: undefined,
    continuesFrom: undefined, stillFileId: undefined, clipFileId: undefined,
  })
  const used = new Set<number>()
  out.shots.forEach((s) => {
    if (s.stillFileId || s.clipFileId) return
    const key = pictureKey(s)
    const i = previous.shots.findIndex((p, j) => !used.has(j) && pictureKey(p) === key)
    if (i < 0) return
    used.add(i)
    const before = previous.shots[i]
    if (before.stillFileId) s.stillFileId = before.stillFileId
    if (before.clipFileId && before.n === s.n && before.durationSeconds === s.durationSeconds && before.continuesFrom === s.continuesFrom) s.clipFileId = before.clipFileId
  })
  return { plan: out, dropped }
}

// Director can record several shots at once (parallel tool calls), and each
// record is load -> modify -> save of the same file: without a lock the last
// save wins and the other shots' files are lost. One orchestrator process, so
// an in-memory promise chain per plan id is enough.
const planLocks = new Map<string, Promise<void>>()
async function withPlanLock<T>(planFileId: string, fn: () => Promise<T>): Promise<T> {
  const previous = planLocks.get(planFileId) ?? Promise.resolve()
  const run = previous.then(fn)
  const tail = run.then(() => undefined, () => undefined)
  planLocks.set(planFileId, tail)
  try {
    return await run
  } finally {
    if (planLocks.get(planFileId) === tail) planLocks.delete(planFileId)
  }
}

export async function runPlanTvc(input: PlanTvcInput, deps: PlanTvcDeps): Promise<PlanTvcOutput> {
  if (input.action === 'check' && !input.planFileId) return runPlanTvcUnlocked(input, deps)
  if (!input.planFileId) return { refused: true, refusalReason: 'PLAN_FILE_ID_REQUIRED' }
  return withPlanLock(input.planFileId, () => runPlanTvcUnlocked(input, deps))
}

async function runPlanTvcUnlocked(input: PlanTvcInput, deps: PlanTvcDeps): Promise<PlanTvcOutput> {
  if (input.action === 'check') {
    if (!input.plan) return { refused: true, refusalReason: 'PLAN_REQUIRED' }
    let planInput = structuredClone(input.plan)
    // Review fix (Important #1): a plan whose shots carry `source` (only
    // plan_tvc cutdown's draft ever sets it) but which has lost `cutdownOf`
    // must be refused here, before anything is saved or priced. Without
    // this, a dropped cutdownOf on the first check saves as an ordinary
    // original: priced as full generation, with the paid generation steps
    // open, while the shots it carries have no clip and no retrim path.
    // No legacy (non-cutdown) plan has `source`, so this never fires for one.
    // Placed AFTER the CUTDOWN_CHANGED comparison below (not before it): a
    // re-check whose saved plan was already a cutdown must still get the
    // more specific CUTDOWN_CHANGED ("this plan is a cutdown of <X>"); this
    // guard only needs to catch the case CUTDOWN_CHANGED can't see — a FIRST
    // check (no previous to compare against) or a re-check whose previous
    // was itself already missing cutdownOf.
    //
    // Review fix (Minor 3): load the previously saved plan and compare
    // cutdownOf now, before any rebuild — so a re-check of an ORIGINAL plan
    // (saved plan has no cutdownOf) that newly carries a cutdownOf gets the
    // right CUTDOWN_CHANGED refusal instead of a misleading CUTDOWN_LENGTH
    // from rebuilding the incoming plan against itself. The rest of
    // `previous`'s checks (reference/length lock) stay below, unchanged,
    // since they depend on `ref`, which is only known after the rebuild.
    let previous: SavedPlan | undefined
    if (input.planFileId) {
      previous = await deps.load(input.planFileId)
      const previousCut = previous.plan.cutdownOf?.planFileId
      if (previousCut !== planInput.cutdownOf?.planFileId) {
        return {
          refused: true,
          refusalReason: previousCut
            ? `CUTDOWN_CHANGED: this plan is a cutdown of ${previousCut}; keep cutdownOf exactly as given`
            : 'CUTDOWN_CHANGED: this plan is an original ad, not a cutdown; make a cutdown with plan_tvc cutdown and check it without planFileId',
        }
      }
      // M3 (review): one shorter version's file never becomes another length.
      if (previousCut && previous.plan.brief.lengthSeconds !== planInput.brief.lengthSeconds) {
        return { refused: true, refusalReason: `CUTDOWN_CHANGED: this plan is the ${previous.plan.brief.lengthSeconds}s shorter version; a ${planInput.brief.lengthSeconds}s one is a new plan: make it with plan_tvc cutdown and check it without planFileId` }
      }
    }
    // Review fix (Important #1): see the comment above `previous`. Reached
    // only when CUTDOWN_CHANGED did not already fire — i.e. no previous
    // plan exists (first check) or the previous plan also had no cutdownOf.
    if (!planInput.cutdownOf && planInput.shots.some((s) => s.source)) {
      return { refused: true, refusalReason: 'CUTDOWN_OF_MISSING: keep cutdownOf exactly as plan_tvc cutdown gave it, and check again' }
    }
    // C4: a cutdown is rebuilt from its original before anything else, so the
    // picture, the clips and the brief always come from the original's plan.
    let master: TvcPlan | undefined
    if (planInput.cutdownOf) {
      try {
        master = (await deps.load(planInput.cutdownOf.planFileId)).plan
      } catch (err) {
        console.error('[planTvc] cutdown original load failed:', (err as Error).message)
        return { refused: true, refusalReason: 'CUTDOWN_ORIGINAL_UNAVAILABLE: could not read the original ad\'s plan; try again' }
      }
      const rebuilt = rebuildCutdown(planInput, master)
      if ('errors' in rebuilt) return { errors: rebuilt.errors, warnings: [] }
      planInput = rebuilt.plan
    }
    const ref = planInput.brief.reference
    // F4: Olmo's own delegation prompt carries "Reference video: <id>" when
    // this ad recreates a reference (hooks.ts's onDelegationStart parses it
    // into requestContext as tvcReferenceVideoFileId) — a live run showed
    // Director dropping brief.reference entirely on the FIRST check, before
    // any previously-saved plan exists for REFERENCE_CHANGED (below) to
    // catch. When the delegation itself said there is a reference, the plan
    // must agree, from the very first check.
    if (!planInput.cutdownOf && deps.expectedReferenceVideoFileId && ref?.videoFileId !== deps.expectedReferenceVideoFileId) {
      return { refused: true, refusalReason: `REFERENCE_VIDEO_MISSING: this ad recreates a reference; set brief.reference.videoFileId to ${deps.expectedReferenceVideoFileId}` }
    }
    // Task 1: the product photo must be an image, and never the reference
    // video itself — checked before anything else so a bad id can't ride
    // through on a plan that otherwise validates.
    const productPhotoFileId = planInput.brief.productPhotoFileId
    if (ref?.videoFileId && ref.videoFileId === productPhotoFileId) {
      return { refused: true, refusalReason: 'PRODUCT_PHOTO_NOT_IMAGE: the product photo must be a photo of the product (jpg/png/webp), not a video; ask the user to upload one' }
    }
    let productPhotoInfo: ProductPhotoInfo
    try {
      productPhotoInfo = await deps.productPhotoInfo(productPhotoFileId)
    } catch (err) {
      console.error('[planTvc] productPhotoInfo failed:', (err as Error).message)
      return { refused: true, refusalReason: 'PRODUCT_PHOTO_UNCHECKED: could not read the product photo; try again' }
    }
    if (!looksLikeProductPhoto(productPhotoInfo.mimeType, productPhotoInfo.pathname)) {
      return { refused: true, refusalReason: 'PRODUCT_PHOTO_NOT_IMAGE: the product photo must be a photo of the product (jpg/png/webp), not a video; ask the user to upload one' }
    }
    // Task 2: the product photo can never be a frame extract_frame pulled
    // from a video (the reference ad or any other) — a live run with no
    // product photo had Director extract the reference's last frame and
    // use Coca-Cola's bottle as "the product".
    if (isExtractedFramePath(productPhotoInfo.pathname)) {
      return { refused: true, refusalReason: 'PRODUCT_PHOTO_FROM_REFERENCE: that image was taken from the reference ad, not the user\'s product; ask the user for a product photo' }
    }
    // M3: the logo is checked like the product photo, and is never the product photo itself.
    const logoFileId = planInput.brief.logoFileId
    if (logoFileId) {
      if (logoFileId === productPhotoFileId) return { refused: true, refusalReason: LOGO_IS_PRODUCT_PHOTO }
      let logoInfo: ProductPhotoInfo
      try {
        logoInfo = await deps.productPhotoInfo(logoFileId)
      } catch (err) {
        console.error('[planTvc] logo lookup failed:', (err as Error).message)
        return { refused: true, refusalReason: LOGO_UNCHECKED }
      }
      if (isSvgFile(logoInfo.mimeType, logoInfo.pathname)) return { refused: true, refusalReason: LOGO_NOT_RASTER }
      if (!looksLikeLogoImage(logoInfo.mimeType, logoInfo.pathname)) return { refused: true, refusalReason: LOGO_NOT_IMAGE }
      // Review fix: mirrors PRODUCT_PHOTO_FROM_REFERENCE — the logo can never
      // be a frame extract_frame pulled from a video either.
      if (isExtractedFramePath(logoInfo.pathname)) {
        return { refused: true, refusalReason: 'LOGO_FROM_REFERENCE: that image was taken from the reference ad, not the brand\'s logo; ask the user to upload the logo' }
      }
    }
    // `previous` (loaded above, before the rebuild) still carries the
    // reference-video identity check below: once a plan is tied to a
    // reference ad, that tie can't be dropped or swapped by a later check.
    if (previous) {
      const previousVideoId = previous.plan.brief.reference?.videoFileId
      if (previousVideoId && previousVideoId !== ref?.videoFileId) {
        return { refused: true, refusalReason: `REFERENCE_CHANGED: keep brief.reference.videoFileId ${previousVideoId}; the reference ad can't be dropped or swapped once planned` }
      }
      // F3: once a reference is planned, lengthSeconds is locked too — the ad's
      // length comes from the reference's own cut structure, so changing it
      // after the fact would silently desync the plan from the reference it
      // was checked against.
      if (previousVideoId && planInput.brief.lengthSeconds !== previous.plan.brief.lengthSeconds) {
        return { refused: true, refusalReason: `LENGTH_CHANGED: keep brief.lengthSeconds ${previous.plan.brief.lengthSeconds}; the ad length can't change once a reference is planned` }
      }
    }
    // P6 (Task 4): cut times always come from the reference file itself, never
    // from Director — overwrite before validation so editing cutTimes can
    // never make a failing plan pass.
    if (ref?.cutTimes !== undefined && !ref.videoFileId) {
      return { refused: true, refusalReason: 'REFERENCE_VIDEO_MISSING: pass brief.reference.videoFileId; cut times are read from the reference file' }
    }
    if (ref?.videoFileId) {
      try {
        const { cutTimes, durationSeconds } = await deps.detectCutTimes(ref.videoFileId)
        // ffprobe on a file that isn't really a video (e.g. an image) still
        // exits 0 with an N/A/0 duration — that is not a usable detection,
        // never a reference with no cuts.
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error(`unusable durationSeconds: ${durationSeconds}`)
        ref.cutTimes = cutTimes
      } catch (err) {
        console.error('[planTvc] detectCutTimes failed:', (err as Error).message)
        return { refused: true, refusalReason: 'REFERENCE_CUTS_UNAVAILABLE: could not read the reference video\'s cut times; try again' }
      }
    }
    const { errors, warnings, plan } = validateTvcPlan(planInput)
    if (errors.length) return { errors, warnings }
    // Only `record` may set the jingle fields — a fresh plan arriving with
    // them (or a re-check carrying them over from input.plan) never passed
    // jingleErrors, so check always starts clean before carryOver decides
    // whether the previously recorded jingle still fits.
    delete plan.jingleFileId; delete plan.signoffFileId; delete plan.signoffSeconds
    let storageKey = deps.newKey()
    let toSave = plan
    let dropped: string[] = []
    if (previous) {
      storageKey = previous.storageKey
      const carried = carryOver(previous.plan, plan)
      toSave = carried.plan
      dropped = carried.dropped
    }
    if (master) toSave = inheritFromMaster(toSave, master)
    const planFileId = await deps.save({ version: 1, storageKey, plan: toSave })
    if (!planFileId) return { refused: true, refusalReason: 'STORAGE_FAILED' }
    const cost = await deps.price(toSave)
    return { planFileId, errors: [], warnings: [...warnings, ...dropped], costCredits: cost.fullCostCredits, shortfallCredits: cost.shortfallCredits }
  }
  if (!input.planFileId) return { refused: true, refusalReason: 'PLAN_FILE_ID_REQUIRED' }
  const doc = await deps.load(input.planFileId)
  if (input.action === 'cutdown') {
    if (input.lengthSeconds === undefined) return { refused: true, refusalReason: 'CUTDOWN_LENGTH_REQUIRED: pass lengthSeconds (6, 15 or 20)' }
    // I2 (review): a shorter version at its own length is being edited — return
    // its saved plan as the draft, to re-check with its own planFileId.
    if (doc.plan.cutdownOf && input.lengthSeconds === doc.plan.brief.lengthSeconds) {
      return { slice: JSON.stringify({ draft: doc.plan, editing: input.planFileId }) }
    }
    // I4 (review): a new length asked of a shorter version is cut from its original.
    let originalId = input.planFileId
    let original = doc.plan
    if (doc.plan.cutdownOf) {
      originalId = doc.plan.cutdownOf.planFileId
      try {
        original = (await deps.load(originalId)).plan
      } catch (err) {
        console.error('[planTvc] cutdown original load failed:', (err as Error).message)
        return { refused: true, refusalReason: 'CUTDOWN_ORIGINAL_UNAVAILABLE: could not read the original ad\'s plan; try again' }
      }
    }
    const out = draftCutdown(original, originalId, input.lengthSeconds, input.keepShots)
    if ('error' in out) return { refused: true, refusalReason: out.error }
    // M4 (review): no planFileId — nothing was saved, and the original's id
    // must never be mistaken for the new plan's.
    return { slice: JSON.stringify(out) }
  }
  // I2 (review): a shorter version has no stills and makes no new video; a
  // moment is changed on the original, then the shorter version is made again.
  const REDO_ON_ORIGINAL = 'CUTDOWN_REDO_ON_ORIGINAL: this is a shorter version cut from the original ad; change the moment on the original ad, then make the shorter version again'
  if (doc.plan.cutdownOf && input.action === 'get' && /^shots /.test((input.slice ?? '').trim())) return { refused: true, refusalReason: REDO_ON_ORIGINAL }
  if (doc.plan.cutdownOf && input.action === 'record' && (input.stillFileId || (input.records ?? []).some((r) => r.stillFileId))) return { refused: true, refusalReason: REDO_ON_ORIGINAL }
  if (input.action === 'get') {
    // E7: the finish slice must never ship with a disclaimer silently
    // dropped because its timing couldn't be placed — refuse instead.
    if ((input.slice ?? '') === 'finish') {
      const legal = legalTimings(doc.plan)
      if (legal.errors.length) return { refused: true, refusalReason: legal.errors.join(' ') }
    }
    try {
      return { planFileId: input.planFileId, slice: JSON.stringify(sliceTvcPlan(doc.plan, input.slice ?? '')) }
    } catch {
      return { refused: true, refusalReason: 'UNKNOWN_SLICE' }
    }
  }
  const records = [...(input.records ?? [])]
  if (input.shot !== undefined) records.push({ shot: input.shot, stillFileId: input.stillFileId, clipFileId: input.clipFileId, keptByUser: input.keptByUser })
  else if (input.stillFileId || input.clipFileId) return { refused: true, refusalReason: 'SHOT_AND_FILE_REQUIRED' }
  if (records.some((r) => !r.stillFileId && !r.clipFileId)) return { refused: true, refusalReason: 'SHOT_AND_FILE_REQUIRED' }
  const jingleFields = [input.jingleFileId, input.signoffFileId, input.signoffSeconds].filter((v) => v !== undefined).length
  if (jingleFields > 0 && jingleFields < 3) return { refused: true, refusalReason: 'JINGLE_RECORD_INCOMPLETE: record jingleFileId, signoffFileId and signoffSeconds together' }
  if (records.length === 0 && !input.narrationFileIds && !input.songFileId && jingleFields === 0) return { refused: true, refusalReason: 'NOTHING_TO_RECORD' }
  if (input.narrationFileIds && input.narrationFileIds.length !== doc.plan.voiceover.length) return { refused: true, refusalReason: 'NARRATION_COUNT_MISMATCH' }
  if (jingleFields === 3) {
    if (!doc.plan.brief.jingle) return { refused: true, refusalReason: 'NO_JINGLE_IN_PLAN: this plan has no brief.jingle; add one with a plan check first' }
    const errs = jingleErrors(doc.plan, input.signoffSeconds!)
    if (errs.length) return { refused: true, refusalReason: errs.join(' ') }
  }
  for (const r of records) {
    if (!r.stillFileId) continue
    const shot = doc.plan.shots.find((s) => s.n === r.shot)
    if (!shot) return { refused: true, refusalReason: 'NO_SUCH_SHOT' }
    if (shot.continuesFrom !== undefined) return { refused: true, refusalReason: `CONTINUING_SHOT_HAS_NO_STILL: shot ${r.shot} starts from shot ${shot.continuesFrom}'s last frame; record its clip only` }
    if (!r.keptByUser && !(await deps.stillChecked(r.stillFileId))) return { refused: true, refusalReason: `STILL_NOT_CHECKED: run check_still on shot ${r.shot}'s still first (or record it with keptByUser when the user chose to keep it)` }
  }
  let next: TvcPlan = doc.plan
  try {
    for (const r of records) next = recordOnPlan(next, r.shot, { stillFileId: r.stillFileId, clipFileId: r.clipFileId })
  } catch {
    return { refused: true, refusalReason: 'NO_SUCH_SHOT' }
  }
  if (input.narrationFileIds) next = { ...next, narrationFileIds: input.narrationFileIds }
  if (input.songFileId) next = { ...next, songFileId: input.songFileId }
  if (jingleFields === 3) next = { ...next, jingleFileId: input.jingleFileId, signoffFileId: input.signoffFileId, signoffSeconds: input.signoffSeconds }
  const planFileId = await deps.save({ ...doc, plan: next })
  if (!planFileId) return { refused: true, refusalReason: 'STORAGE_FAILED' }
  return { planFileId }
}

export const planTvc = createTool({
  id: 'plan-tvc',
  description: 'Free. The TVC ad plan: "check" validates the plan against the TVC craft rules and saves it (returns the plan id and cost, or plain errors to fix); "get" returns only the slice one step needs; "record" attaches finished stills or clips to their shots (all of a step\'s files in one call, with records) and the finish narration and song to the plan. The finish can also record the sung sign-off (jingleFileId, signoffFileId, signoffSeconds); record refuses one that overlaps speech or is too long. Use only in the TVC ad flow. check also works out every disclaimer\'s start (from the voiceover block that makes the claim) and its ASCI hold, and refuses LEGAL_TOO_LONG, LEGAL_HOLD_TOO_LONG, LEGAL_OVERLAP or LEGAL_CLAIM_MISSING; the finish slice lists the legal lines with their times and the finish order. check also validates prices (PRICE_INVALID, PRICE_MRP_NOT_HIGHER, PRICE_TOO_SHORT) and the logo (LOGO_IS_PRODUCT_PHOTO, LOGO_NOT_RASTER, LOGO_NOT_IMAGE, LOGO_UNCHECKED, LOGO_FROM_REFERENCE), and sets pop on shot text and fade on the tagline when no motion is given; the finish slice carries each shot\'s motion and price, and an endCard (logoFileId, vegMark, disclaimerLines) for composite_end_card. A 30s plan may have up to 20 shots; when it has more than 12, the finish slice also has joinGroups (two lists of shot numbers) and finalJoin true, and finishOrder lists the three joins (assemble_clips group 1, group 2, final). cutdown (free, saves nothing) returns a draft shorter version of a finished ad from its own clips: the shots plan_tvc picked (each with its source), their new lengths, and the original\'s voiceover; write the shorter voiceover and legal lines into the draft and check it without planFileId. Given a shorter version\'s own id at its own length, cutdown returns its saved plan to edit (re-check with that id). A cutdown\'s finish slice lists retrims (trim_clip from the original clip, then record) and musicFadeOutAtSeconds. A shorter version refuses a shots slice or a still (CUTDOWN_REDO_ON_ORIGINAL): moments are changed on the original.',
  inputSchema: planTvcInputSchema,
  outputSchema: z.object({
    planFileId: z.string().optional(),
    errors: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
    costCredits: z.number().optional(),
    shortfallCredits: z.number().optional(),
    slice: z.string().optional(),
    refused: z.boolean().optional(),
    refusalReason: z.string().optional(),
  }),
  execute: async (inputData, execContext) => {
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    if (!idToken || !conversationId) return { refused: true, refusalReason: 'NO_SESSION_CONTEXT' }
    const deps: PlanTvcDeps = {
      load: async (planFileId) => {
        const url = new URL(await fetchPresignedUrl(planFileId, idToken))
        url.searchParams.delete('x-amz-checksum-mode')
        const res = await fetch(url.toString())
        if (!res.ok) throw new Error(`plan ${planFileId}: ${res.status}`)
        return await res.json() as SavedPlan
      },
      save: async (doc) => (await uploadFileWithKey(idToken, {
        key: doc.storageKey, name: 'TVC plan.json', content: JSON.stringify(doc), contentType: 'application/json',
      }))?.fileId ?? null,
      price: async (plan) => {
        const result = await computeCreditPlan(tvcCreditSteps(plan), { priceMicro: priceFromRates, readBalance: () => readBalanceForTenant(tenantId) })
        return { fullCostCredits: result.fullCostCredits, shortfallCredits: result.shortfallCredits }
      },
      newKey: () => `generated/${conversationId}/tvc-plan-${randomUUID()}.json`,
      stillChecked: (id) => stillPassedCheck({ threadId: conversationId, resourceId: tenantId }, id),
      detectCutTimes: (videoFileId) => detectCutTimes(videoFileId, idToken, tenantId || conversationId, REFERENCE_CUT_THRESHOLD),
      productPhotoInfo: (fileId) => resolveProductPhotoInfo(fileId, idToken),
      expectedReferenceVideoFileId: execContext?.requestContext?.get('tvcReferenceVideoFileId') as string | undefined,
    }
    try {
      return await runPlanTvc(inputData as PlanTvcInput, deps)
    } catch (err) {
      console.error('[planTvc] failed:', (err as Error).message)
      return { refused: true, refusalReason: 'PLAN_UNAVAILABLE' }
    }
  },
})
