import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { generatedFileKey, uploadFileWithKey, uploadGeneratedFile } from '../../persistence.js'
import { fetchPresignedUrl, downloadToSessionCache } from './mediaCache.js'
import { refundAssemblyCharge } from './assemblyCredits.js'
import { shouldRequireApproval } from './generationApproval.js'
import { stableToolCallId } from '../../credits.js'
import { fileTitle } from './fileTitle.js'
import { LEGAL_TEXT_KEY_MARKER } from './legalText.js'
import { LOGO_NOT_IMAGE, LOGO_NOT_RASTER, sniffImage } from './packshotMarks.js'
import { endCardInputs, signoffTiming, type TvcPlan } from './tvcPlan.js'
import { buildAss } from './overlayText.js'
import { buildVoiceoverFilter, levelMatchJingles, timeVoiceoverBlocks, type MixBlock } from './mixVoiceover.js'
import { bedLoudness, buildMusicBedFilter, MIN_ACCEPTABLE_BED_LUFS } from './mixMusicBed.js'
import { endCardGraph, endCardMarks, inspectLogo } from './compositeEndCard.js'
import { markShotReviewed } from './reviewGate.js'
import { loadSavedPlan } from './planTvc.js'
import { ANIMATIC_FPS, animaticOverlays, frameSize, missingAudio, missingStills, pushInFilter, segmentFrames, stillSources, withRoughCutLabel, zoomRanges } from './animatic.js'

// render_animatic (spec 2026-10-10 R4): one call turns a TVC plan's approved
// stills into a timed rough cut with the real voiceover, music, end card and
// text, before any video is paid for. A fixed series of ffmpeg passes that
// mirror the finish, reusing its builders so the rough cut sounds and reads
// like the final.

const execFile = promisify(execFileCb)
const SUBJECT = 'ffmpeg-render-animatic'
const PASS_TIMEOUT_MS = 120_000
const BUDGET_MS = 270_000
const MAX_SOURCE_BYTES = 200 * 1024 * 1024
const DISSOLVE_WINDOW_SECONDS = 1.5 // composite_end_card's own window

type Logo = { width: number; height: number; transparent: boolean }

export interface RenderJob {
  workDir: string
  width: number
  height: number
  lengthSeconds: number
  frames: number[]
  zooms: Array<[number, number]>
  stillPaths: string[]
  photoPath: string
  logo?: Logo & { path: string }
  vegMark?: 'veg' | 'non_veg'
  disclaimerLines?: number
  ass: string
  voPaths: string[]
  timed: MixBlock[]
  blockLufs: number[]
  bedPath: string
  fadeOutAtSeconds?: number
}

export interface AnimaticDeps {
  loadPlan: (planFileId: string) => Promise<TvcPlan>
  fetchLocal: (fileId: string) => Promise<{ path: string; buf: Buffer }>
  timeBlocks: (voPaths: string[], blocks: Array<{ startSeconds: number; kind?: 'voice' | 'jingle' }>, videoSeconds: number) => Promise<{ timed: MixBlock[]; blockLufs: number[] } | { refusalReason: string }>
  bedLufs: (bedPath: string) => Promise<number | null>
  inspectLogo: (path: string) => Promise<Logo>
  charge: () => Promise<'ok' | 'insufficient'>
  refund: () => Promise<void>
  render: (job: RenderJob) => Promise<string>
  upload: (outputPath: string, carriesLegal: boolean, title: string) => Promise<{ fileId: string; name: string; fileType: string; size: number } | null>
  voiceHeard: () => void
  workDir?: () => string
}

export interface AnimaticOutput {
  fileId?: string; name?: string; fileType?: string; size?: number
  status?: string; refused?: boolean; refusalReason?: string; insufficientCredits?: boolean
}

const refuse = (refusalReason: string): AnimaticOutput => ({ refused: true, refusalReason })

/** The tool's logic with every side effect injected, so each refusal and refund path is testable. */
export async function runRenderAnimatic(planFileId: string, deps: AnimaticDeps): Promise<AnimaticOutput> {
  let plan: TvcPlan
  try { plan = await deps.loadPlan(planFileId) } catch { return refuse('PLAN_UNAVAILABLE: could not read the TVC plan; try again') }
  if (plan.cutdownOf) return refuse('ANIMATIC_CUTDOWN: a shorter version is cut from finished clips and needs no rough cut')
  const noStill = missingStills(plan)
  if (noStill.length) return refuse(`ANIMATIC_STILLS_MISSING: shot ${noStill.join(', ')} has no approved still yet; make and record it first`)
  const noAudio = missingAudio(plan)
  if (noAudio.length) return refuse(`ANIMATIC_AUDIO_MISSING: record the ${noAudio.join(' and ')} first (plan_tvc get "animatic" lists the steps)`)
  const overlays = animaticOverlays(plan)
  if ('refusalReason' in overlays) return refuse(overlays.refusalReason)

  const length = plan.brief.lengthSeconds
  const { width, height } = frameSize(plan.brief.aspectRatio)
  const sources = stillSources(plan) as string[]
  const signoff = signoffTiming(plan)
  const card = endCardInputs(plan)
  let job: RenderJob
  try {
    const stills = await Promise.all(sources.map((id) => deps.fetchLocal(id)))
    const photo = await deps.fetchLocal(plan.brief.productPhotoFileId)
    let logo: RenderJob['logo']
    if (card?.logoFileId) {
      const file = await deps.fetchLocal(card.logoFileId)
      const kind = sniffImage(file.buf)
      if (kind === 'svg') return refuse(LOGO_NOT_RASTER)
      if (kind === 'other') return refuse(LOGO_NOT_IMAGE)
      try { logo = { ...(await deps.inspectLogo(file.path)), path: file.path } } catch { return refuse(LOGO_NOT_IMAGE) }
    }
    const narration = await Promise.all((plan.narrationFileIds ?? []).map((id) => deps.fetchLocal(id)))
    const blocks: Array<{ startSeconds: number; kind?: 'voice' | 'jingle' }> = plan.voiceover.map((b) => ({ startSeconds: b.startSeconds }))
    const voPaths = narration.map((f) => f.path)
    if (signoff && plan.signoffFileId) {
      voPaths.push((await deps.fetchLocal(plan.signoffFileId)).path)
      blocks.push({ startSeconds: signoff.signoffStartSeconds, kind: 'jingle' })
    }
    let timed: MixBlock[] = []
    let blockLufs: number[] = []
    if (voPaths.length) {
      const checked = await deps.timeBlocks(voPaths, blocks, length)
      if ('refusalReason' in checked) return refuse(checked.refusalReason)
      ;({ timed, blockLufs } = checked)
    }
    const bed = await deps.fetchLocal(plan.songFileId!)
    const lufs = await deps.bedLufs(bed.path)
    if (lufs === null || lufs < MIN_ACCEPTABLE_BED_LUFS) return refuse('MUSIC_BED_INAUDIBLE')
    job = {
      workDir: '', width, height, lengthSeconds: length,
      frames: segmentFrames(plan.shots.map((s) => s.durationSeconds)), zooms: zoomRanges(plan),
      stillPaths: stills.map((f) => f.path), photoPath: photo.path, logo,
      vegMark: card?.vegMark, disclaimerLines: card?.disclaimerLines,
      ass: withRoughCutLabel(buildAss(overlays, { width, height }), length),
      voPaths, timed, blockLufs, bedPath: bed.path,
      ...(signoff ? { fadeOutAtSeconds: signoff.musicFadeOutAtSeconds } : {}),
    }
  } catch (err) {
    console.error('[renderAnimatic] preparing sources failed:', (err as Error).message)
    return refuse('SOURCE_UNAVAILABLE')
  }

  if ((await deps.charge()) === 'insufficient') return { insufficientCredits: true }
  let workDir: string
  try {
    workDir = deps.workDir ? deps.workDir() : mkdtempSync(join(tmpdir(), 'animatic-'))
  } catch {
    await deps.refund()
    return refuse('ANIMATIC_FAILED')
  }
  try {
    let outputPath: string
    try {
      outputPath = await deps.render({ ...job, workDir })
    } catch (err) {
      const message = (err as Error).message
      console.error('[renderAnimatic] render failed:', message)
      await deps.refund()
      return refuse(message.startsWith('ANIMATIC_LENGTH_MISMATCH') ? 'ANIMATIC_LENGTH_MISMATCH' : 'ANIMATIC_FAILED')
    }
    const carriesLegal = plan.legal.length > 0
    const title = fileTitle(`Animatic ${plan.brief.brandName ?? ''}`.trim(), 'Animatic')
    const attachment = await deps.upload(outputPath, carriesLegal, title)
    if (!attachment) {
      await deps.refund()
      return refuse('STORAGE_FAILED')
    }
    deps.voiceHeard()
    return { ...attachment, status: `Rough cut ready: ${length}s, ${plan.shots.length} stills with the voiceover and music` }
  } finally {
    if (!deps.workDir) rmSync(workDir, { recursive: true, force: true })
  }
}

async function frameCount(path: string): Promise<number> {
  const { stdout } = await execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', path], { timeout: PASS_TIMEOUT_MS })
  return parseInt(stdout.trim(), 10)
}

const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']

/** The ffmpeg passes, in the finish's order: push-in segments, join, end card, text and label with a silent
 *  track, voiceover, then the bed. Each call has its own timeout, and the whole render a budget. */
export async function renderAnimaticPasses(job: RenderJob): Promise<string> {
  const startedAt = Date.now()
  const run = async (args: string[]) => {
    if (Date.now() - startedAt > BUDGET_MS) throw new Error('ANIMATIC_TIMEOUT: the render ran past its time budget')
    await execFile('ffmpeg', ['-y', '-v', 'error', ...args], { timeout: PASS_TIMEOUT_MS })
  }
  const at = (name: string) => join(job.workDir, name)
  const segments: string[] = []
  for (let i = 0; i < job.frames.length; i++) {
    const out = at(`seg-${String(i).padStart(2, '0')}.mp4`)
    await run(['-i', job.stillPaths[i], '-vf', pushInFilter(job.width, job.height, job.frames[i], job.zooms[i]), '-frames:v', String(job.frames[i]), '-r', String(ANIMATIC_FPS), ...X264, out])
    segments.push(out)
  }
  const list = at('segments.txt')
  writeFileSync(list, segments.map((s) => `file '${s}'`).join('\n'))
  await run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', at('joined.mp4')])
  const expected = Math.round(job.lengthSeconds * ANIMATIC_FPS)
  const got = await frameCount(at('joined.mp4'))
  if (got !== expected) throw new Error(`ANIMATIC_LENGTH_MISMATCH: ${got} frames, expected ${expected}`)

  const dissolveStart = Math.max(0, job.lengthSeconds - DISSOLVE_WINDOW_SECONDS)
  const marks = endCardMarks({ width: job.width, height: job.height }, job.logo, job.vegMark, job.disclaimerLines, [], dissolveStart, job.lengthSeconds)
  const t = String(job.lengthSeconds)
  await run([
    '-i', at('joined.mp4'),
    '-loop', '1', '-framerate', '30', '-t', t, '-i', job.photoPath,
    ...(job.logo ? ['-loop', '1', '-framerate', '30', '-t', t, '-i', job.logo.path] : []),
    '-filter_complex', endCardGraph(job.width, job.height, dissolveStart, 0, undefined, marks),
    '-map', '[outv]', ...X264, '-t', t, at('carded.mp4'),
  ])

  const assPath = at('animatic.ass')
  writeFileSync(assPath, job.ass)
  const escapedAss = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
  await run([
    '-i', at('carded.mp4'), '-f', 'lavfi', '-t', t, '-i', 'anullsrc=r=48000:cl=stereo',
    '-vf', `subtitles=${escapedAss}`, '-map', '0:v', '-map', '1:a', ...X264, '-c:a', 'aac', '-t', t, at('texted.mp4'),
  ])

  let voiced = at('texted.mp4')
  if (job.voPaths.length) {
    let timed = job.timed
    if (timed.some((b) => b.kind === 'jingle')) timed = await levelMatchJingles([voiced, ...job.voPaths], timed, job.blockLufs, true)
    await run([
      '-i', voiced, ...job.voPaths.flatMap((p) => ['-i', p]),
      '-filter_complex', buildVoiceoverFilter(timed, true), '-map', '0:v', '-map', '[outa]', '-c:v', 'copy', '-c:a', 'aac', '-t', t, at('voiced.mp4'),
    ])
    voiced = at('voiced.mp4')
  }
  await run([
    '-i', voiced, '-i', job.bedPath,
    '-filter_complex', buildMusicBedFilter(job.fadeOutAtSeconds), '-map', '0:v', '-map', '[outa]', '-c:v', 'copy', '-c:a', 'aac', '-t', t, at('animatic.mp4'),
  ])
  return at('animatic.mp4')
}

export const inputSchema = z.object({
  planFileId: z.string().describe('The TVC plan id; the tool reads the stills, timing, text and recorded audio from it'),
})

const outputSchema = z.object({
  fileId: z.string().optional(), name: z.string().optional(), fileType: z.string().optional(), size: z.number().optional(),
  status: z.string().optional(), refused: z.boolean().optional(), refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(), creditsUsedMicro: z.string().optional(), jobId: z.string().optional(),
})

export const renderAnimatic = createTool({
  id: 'render-animatic',
  description: 'TVC ad, Ask mode, after the stills: turns the plan\'s approved stills into a timed rough cut (a slow push-in on each still) with the recorded narration, music bed, sung sign-off, end card and on-screen text, and a ROUGH CUT mark. Takes only planFileId. Record the narration, music and any jingle with plan_tvc first (plan_tvc get "animatic" lists what is missing). Refuses, uncharged: ANIMATIC_CUTDOWN, ANIMATIC_STILLS_MISSING, ANIMATIC_AUDIO_MISSING, LEGAL_TIMING_ERRORS, VOICEOVER_TOO_LONG, VOICEOVER_INAUDIBLE, MUSIC_BED_INAUDIBLE. Returns one fileId.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) => shouldRequireApproval({ resourceType: 'clip_assembly', subject: SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { planFileId } = inputData as z.infer<typeof inputSchema>
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? 'unknown'}:${stableToolCallId(toolCallId)}`
    if (!idToken || !conversationId) return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    const scopeId = tenantId || conversationId
    const chargeKey = `render-animatic:${jobId}:0`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n
    const out = await runRenderAnimatic(planFileId, {
      loadPlan: async (id) => (await loadSavedPlan(id, idToken)).plan,
      fetchLocal: async (id) => {
        const file = await downloadToSessionCache(scopeId, id, await fetchPresignedUrl(id, idToken), MAX_SOURCE_BYTES)
        return { path: file.filePath, buf: file.buf }
      },
      timeBlocks: timeVoiceoverBlocks,
      bedLufs: bedLoudness,
      inspectLogo,
      charge: async () => {
        if (await isUnlimited(tenantId)) return 'ok'
        const rate = await resolveRate('clip_assembly', SUBJECT)
        if (!rate) {
          console.error(`[credits] UNBILLED RENDER-ANIMATIC: no active clip_assembly/${SUBJECT} rate tenantId=${tenantId} — generation was NOT charged`)
          return 'ok'
        }
        rateId = rate.id
        rateVersion = rate.version
        amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({ tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit', actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'clip_assembly' })
          charged = true
          return 'ok'
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return 'insufficient'
          throw err
        }
      },
      refund: async () => { if (charged) await refundAssemblyCharge(tenantId, agentId, chargeKey, rateId, rateVersion) },
      render: renderAnimaticPasses,
      upload: async (path, carriesLegal, title) => {
        const content = readFileSync(path)
        const a = carriesLegal
          ? await uploadFileWithKey(idToken, { key: generatedFileKey(conversationId, `${LEGAL_TEXT_KEY_MARKER} ${title}`, 'mp4'), name: `${title}.mp4`, content, contentType: 'video/mp4' })
          : await uploadGeneratedFile(idToken, { conversationId, title, content, contentType: 'video/mp4', extension: 'mp4' })
        return a ? { fileId: a.fileId, name: a.name, fileType: a.type, size: a.size } : null
      },
      voiceHeard: () => markShotReviewed(conversationId, 'voice'),
    })
    return { ...out, ...(charged && out.fileId ? { creditsUsedMicro: amountMicro.toString() } : {}), jobId }
  },
})
