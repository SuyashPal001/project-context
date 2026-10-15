import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { linkSchema } from '../tools/videoBreakdown/links.js'
import { breakDownVideo, recentBreakdown, type Breakdown } from '../tools/videoBreakdown/breakDownVideo.js'
import { shouldRequireApproval } from '../tools/generationApproval.js'
import { imageModelFor } from '../tools/imageEngine.js'
import { VEO_CLIP_MODEL } from '../tools/veoClip.js'
import { refuseReason } from './looks.js'
import { credits } from './cost.js'
import { remakeMastra, REMAKE_WORKFLOW_ID } from './instance.js'
import { RemakeAccessError } from './workflow.js'

// Messages the steps throw that are already plain words for the user; anything else
// is logged and replaced with a generic line (no internals reach the user).
const PLAIN = /^(not enough credits|the .* could not be (made|saved))/
const brandSchema = z.object({ name: z.string().min(1), product: z.string().min(1), productPhotoFileId: z.string().optional(), audience: z.string().optional(), notes: z.string().optional() })
const lineSchema = z.object({ ref: z.string(), action: z.enum(['keep', 'swap', 'drop']), to: z.string().optional(), why: z.string().optional() })

type Out = { success: boolean } & Record<string, unknown>
export type RunResult = { status: string; steps?: Record<string, { suspendPayload?: Record<string, unknown>; error?: unknown; output?: Record<string, unknown> }>; result?: Record<string, unknown>; error?: unknown }

function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : (e as { message?: string } | undefined)?.message ?? ''
  if (e instanceof RemakeAccessError || msg === 'not_found') return 'not_found'
  if (PLAIN.test(msg)) return msg
  // Acting on a step the run is already past (approve twice, edit after approving) or a
  // second resume racing the first: plain words, and never a hint to start over and pay again.
  if (/not suspended|already/i.test(msg)) return 'that step is already done or in progress; use status to see where the remake is'
  return 'the remake stopped; please try again'
}

const plainSummary = (v: unknown) => {
  const s = v as { spentMicro: string; wastedMicro: string; failed: string[]; blocked: string[] }
  return { spentCredits: credits(s.spentMicro), wastedCredits: credits(s.wastedMicro), failed: s.failed, blocked: s.blocked }
}

export function shapeRun(runId: string, r: RunResult): Out {
  // Stills run inside one long tool call; a status check meanwhile must not read as a failure.
  if (r.status === 'running' || r.status === 'pending') return { success: true, runId, stage: 'working' }
  if (r.status === 'suspended') {
    const p = Object.values(r.steps ?? {}).map((s) => s.suspendPayload).filter((x) => x && x.stage).pop() as Out | undefined
    if (!p) return { success: false, runId, error: 'the remake stopped; please try again' }
    if (p.stage === 'plan_review') {
      const e = p.estimate as { images: number; firstPassMicro: string | null; maxMicro: string | null }
      const plan = p.plan as { warnings?: string[] }
      return { success: true, runId, stage: 'plan_review', plan: p.plan, warnings: plan.warnings ?? [], estimate: { images: e.images, firstPassCredits: credits(e.firstPassMicro), maxCredits: credits(e.maxMicro) } }
    }
    if (p.stage === 'preview_review') {
      const e = p.clipsEstimate as { clips: number; firstPassMicro: string | null; maxMicro: string | null }
      return { success: true, runId, stage: 'preview_review', previewFileId: p.previewFileId, stills: p.stills, summary: plainSummary(p.summary), clipsEstimate: { clips: e.clips, firstPassCredits: credits(e.firstPassMicro), maxCredits: credits(e.maxMicro) }, ...(p.cantAnimate ? { cantAnimate: p.cantAnimate } : {}) }
    }
    return { success: true, runId, stage: 'cast_pick', sheetFileId: p.sheetFileId, ...(p.error ? { error: p.error } : {}) }
  }
  const result = r.result ?? r.steps?.finish?.output
  if (r.status === 'success' && result) {
    if (result.finalFileId) return { success: true, runId, stage: 'final_ready', finalFileId: result.finalFileId, note: result.note, clips: result.clips, summary: plainSummary(result.summary) }
    // Clips were paid but no final video came out: show the clips, never "preview ready".
    if (result.stopped === false) return { success: false, runId, stage: 'final_failed', clips: result.clips, note: result.note, summary: plainSummary(result.summary), error: 'the final video couldn’t be put together this time; the animated parts are listed' }
    return { success: true, runId, stage: 'preview_ready', previewFileId: result.previewFileId, stills: result.stills, summary: plainSummary(result.summary), ...(result.note ? { note: result.note } : {}) }
  }
  const stepErr = Object.values(r.steps ?? {}).map((s) => s.error).find(Boolean) ?? r.error
  console.error('[remake] run ended', r.status, stepErr)
  return { success: false, runId, error: errorText(stepErr) }
}

export const remakeVideoTool = createTool({
  id: 'remake_video',
  description: 'Remake a reference video for the user\'s brand, step by step, with the user approving each paid step. '
    + 'start (link or fileId + brand: name, product, optional productPhotoFileId/audience/notes; optional castFileId when the user brings their own person): returns the remake plan (each part of the video kept, swapped or dropped) and the cost of the stills. Show the plan in plain words and ask for changes. '
    + 'edit_plan (runId + edits) for changes; approve_plan (runId) when the user agrees. If the video has a person, approve_plan returns a casting sheet of 3 new people: show it and ask which one (pick_cast, runId + pick 1-3). '
    + 'If cast_pick comes back with an error and no sheetFileId, tell the user the error; once fixed, call pick_cast with no pick to make the sheet again. If it has an error and a sheet, ask the user to pick again. '
    + 'Then every look gets checked stills and a free preview video (stage preview_review): share the preview, say which stills failed or were held back, the credits spent, and the cost to animate it (clipsEstimate). If it has cantAnimate, say so and stop there. If the user wants it animated, call approve_preview (runId); if they only wanted the preview, call stop. '
    + 'If stage final_failed comes back, share its note and say the animated parts were made but could not be joined; never start again on your own. '
    + 'When it is done (stage final_ready), share the video and its note exactly as given (what changed on purpose, what stayed a still, anything that did not pass), the credits spent, and remind the user to label it as AI-generated when they post it. '
    + 'stage working means it is still making the stills: wait and use status; never call start again while a remake for this video exists (that pays twice). '
    + 'Never describe how it works inside; use plain outcome words. status (runId) re-reads where a remake is.',
  inputSchema: z.object({
    action: z.enum(['start', 'edit_plan', 'approve_plan', 'pick_cast', 'approve_preview', 'stop', 'status']),
    url: linkSchema.optional(), fileId: z.string().optional(),
    brand: brandSchema.optional(),
    castFileId: z.string().optional().describe('start: the user\'s own person (an avatar or photo fileId); skips the casting sheet'),
    runId: z.string().optional(),
    edits: z.array(lineSchema).optional(),
    pick: z.number().int().min(1).max(3).optional(),
  }),
  outputSchema: z.object({ success: z.boolean() }).passthrough(),
  requireApproval: async (input, ctx) => {
    const action = (input as { action?: string }).action
    if (action === 'approve_preview') return shouldRequireApproval({ resourceType: 'video_generation', subject: VEO_CLIP_MODEL }, ctx as never)
    if (action !== 'approve_plan' && action !== 'pick_cast') return false
    return shouldRequireApproval({ resourceType: 'image_generation', subject: imageModelFor('gemini').rateSubject }, ctx as never)
  },
  execute: async (input, execContext) => {
    const rc = execContext?.requestContext
    const tenantId = rc?.get('tenantId') as string | undefined
    const idToken = rc?.get('idToken') as string | undefined
    const sessionId = rc?.get('sessionId') as string | undefined
    const conversationId = (rc?.get('conversationId') as string | undefined) ?? sessionId
    if (!rc || !tenantId || !idToken || !conversationId) return { success: false, error: 'no_active_session' }
    const w = (await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID)
    try {
      if (input.action === 'start') {
        if (!input.brand) return { success: false, error: 'brand_required' }
        if (!input.url && !input.fileId) return { success: false, error: 'link_or_file_required' }
        const ref = { url: input.url, fileId: input.fileId }
        const b: Breakdown = recentBreakdown(ref, { scopeId: tenantId }) ?? await breakDownVideo(ref, { idToken, scopeId: tenantId, conversationId }, tenantId)
        const refusal = refuseReason(b)
        if (refusal) return { success: false, error: refusal }
        const run = await w.createRun()
        const r = await run.start({ inputData: { tenantId, conversationId, breakdown: b, brand: input.brand, castFileId: input.castFileId }, requestContext: rc as never })
        return shapeRun(run.runId, r as unknown as RunResult)
      }
      if (!input.runId) return { success: false, error: 'runId_required' }
      const state = await w.getWorkflowRunById(input.runId) as unknown as (RunResult & { payload?: { tenantId?: string; conversationId?: string } }) | null
      if (!state || state.payload?.tenantId !== tenantId || state.payload?.conversationId !== conversationId) return { success: false, error: 'not_found' }
      if (input.action === 'status') return shapeRun(input.runId, state)
      const [step, resumeData] = input.action === 'edit_plan' ? ['plan', { decision: 'edit', edits: input.edits ?? [] }]
        : input.action === 'approve_plan' ? ['plan', { decision: 'approve' }]
        : input.action === 'approve_preview' ? ['preview', { decision: 'approve' }]
        : input.action === 'stop' ? ['preview', { decision: 'stop' }]
        : ['cast', input.pick ? { pick: input.pick } : {}]
      const run = await w.createRun({ runId: input.runId })
      const r = await run.resume({ step, resumeData, requestContext: rc as never })
      return shapeRun(input.runId, r as unknown as RunResult)
    } catch (err) {
      console.error('[remake] tool failed:', err instanceof Error ? err.message : String(err))
      return { success: false, error: errorText(err) }
    }
  },
})
