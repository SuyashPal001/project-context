// Every side effect of a remake run, behind one seam so the workflow is testable
// without a gateway, a model, a store or ffmpeg.
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { costMicro, resolveRate } from '@serverless-saas/credits'
import { generateImageItem, type ImageItemInput } from '../tools/generateImage.js'
import type { MediaExecContext } from '../tools/batchRunner.js'
import { gatewayAsk, sampleFrames, type AskFn, type Img } from '../tools/tvcChecks.js'
import { remakeStillChecks } from './stillChecks.js'
import { sameSetting } from '../tools/sameSetting.js'
import { fetchBase64 } from '../tools/checkClip.js'
import { fetchPresignedUrl, downloadToSessionCache } from '../tools/mediaCache.js'
import { uploadFileWithKey, deleteFile, generatedFileKey } from '../../persistence.js'
import { aiService, type ImagePose, type PoseResult } from '../tools/videoBreakdown/aiServiceClient.js'
import { generateVideoItem, VIDEO_MODEL } from '../tools/generateVideo.js'
import { generateVeoClipItem, VEO_CLIP_MODEL } from '../tools/veoClip.js'
import { generateSongItem } from '../tools/generateSong.js'
import { compareToReference } from '../tools/videoBreakdown/compareToReference.js'
import type { Breakdown } from '../tools/videoBreakdown/breakDownVideo.js'
import { fitClipToFrames, stillToFrames, joinClips, fitMusicToLength, setOnlyAudio, cutPanels } from '../tools/mediaCore.js'
import { cropImageLocal, findHead, type CropFraming } from '../tools/cropImage.js'
import { checkModel } from '../tools/videoBreakdown/models.js'
import { imageModelFor } from '../tools/imageEngine.js'
import { runGate, type CheckResult } from '../scorers/video/gate.js'
import { promptCheckScorer } from '../scorers/video/promptCheck.js'
import { renderPreview, type PreviewJob } from './preview.js'
import type { stillGateInput } from './prompts.js'

const execFile = promisify(execFileCb)
const MAX_LOCAL_BYTES = 300 * 1024 * 1024
export const REMAKE_COST = { agentId: 'video-remake', workflowId: 'video-remake' }

export interface RemakeDeps {
  ask: (tenantId: string) => AskFn
  generateStill: (input: ImageItemInput, exec: MediaExecContext, index: number) => Promise<{ fileId?: string; refused?: boolean; refusalReason?: string; insufficientCredits?: boolean; creditsUsedMicro?: string }>
  fetchImage: (fileId: string, idToken: string) => Promise<Img>
  localFile: (fileId: string, idToken: string, scopeId: string) => Promise<string>
  upload: (idToken: string, key: string, name: string, content: Buffer, contentType: string) => Promise<string | null>
  poseImage: (path: string) => Promise<ImagePose>
  /** A kept still cropped around the face to a tighter framing (free; crop_image's core); the new file's id. */
  cropStill?: (fileId: string, framing: CropFraming, aspectRatio: '9:16' | '16:9' | '1:1', ctx: { idToken: string; scopeId: string; tenantId: string; runId: string; conversationId?: string }) => Promise<string>
  /** A board of photos cut apart on its white gaps (mediaCore's cutPanels); the photos' file ids, or null. */
  cutBoard: (fileId: string, n: number, aspectRatio: '9:16' | '16:9' | '1:1', ctx: { idToken: string; scopeId: string; tenantId: string; runId: string; conversationId?: string }) => Promise<string[] | null>
  promptGate: (input: Omit<ReturnType<typeof stillGateInput>, 'look'> & { look: Record<string, unknown>; tenantId: string }) => Promise<CheckResult>
  stillChecks: (ask: AskFn, still: Img, opts: { lead?: Img; leadInShot?: boolean; faceMayHide?: boolean }) => Promise<{ passed: boolean; reasons: string[]; warnings?: string[] }>
  /** Same place? (tools/sameSetting) — keeps later stills in the first still's room. */
  sameSetting: typeof sameSetting
  ffmpeg: (args: string[]) => Promise<void>
  readFile: (path: string) => Buffer
  renderPreview: (job: PreviewJob) => Promise<string>
  imageRateMicro: () => Promise<bigint | null>
  // 3b: clips, music, final checks
  generateVeoClip: typeof generateVeoClipItem
  generateOmniClip: (input: { prompt: string; startImageFileId: string; durationSeconds: number; aspectRatio: '9:16' | '16:9'; title: string }, exec: MediaExecContext, index: number) => Promise<{ fileId?: string; refused?: boolean; refusalReason?: string; insufficientCredits?: boolean; creditsUsedMicro?: string }>
  poseClip: (path: string, seconds: number) => Promise<PoseResult>
  sample: (path: string, times: number[]) => Promise<Img[]>
  fitToFrames: typeof fitClipToFrames
  clipRateMicro: (engine: 'veo' | 'omni') => Promise<bigint | null>
  musicRateMicro: () => Promise<bigint | null>
  generateMusic: (prompt: string, exec: MediaExecContext, runKey: string) => Promise<{ fileId?: string; refused?: boolean; refusalReason?: string; insufficientCredits?: boolean; creditsUsedMicro?: string }>
  compare: (breakdown: Breakdown, remakeFileId: string, ctx: { idToken: string; scopeId: string; conversationId: string }, tenantId: string) => Promise<{ checks: CheckResult[]; summary: string }>
  stillToFrames: typeof stillToFrames
  joinSegments: (parts: string[], out: string, size: { width: number; height: number }) => Promise<string>
  fitMusic: typeof fitMusicToLength
  muxMusic: typeof setOnlyAudio
  // temp working dirs: every one a run makes is removed when the step that needs it is done
  tempDir: (prefix: string) => string
  removeDir: (path: string) => void
  deleteFile: (idToken: string, fileId: string) => Promise<boolean>
}

const real: RemakeDeps = {
  ask: (tenantId) => gatewayAsk(tenantId, fetch, checkModel(), REMAKE_COST),
  generateStill: (input, exec, index) => generateImageItem(input, exec, index),
  fetchImage: (fileId, idToken) => fetchBase64(fileId, idToken, AbortSignal.timeout(120_000)),
  localFile: async (fileId, idToken, scopeId) => (await downloadToSessionCache(scopeId, fileId, await fetchPresignedUrl(fileId, idToken), MAX_LOCAL_BYTES)).filePath,
  upload: async (idToken, key, name, content, contentType) => (await uploadFileWithKey(idToken, { key, name, content, contentType }))?.fileId ?? null,
  poseImage: (path) => aiService<ImagePose>('/media/pose-image', { path }),
  cropStill: async (fileId, framing, aspectRatio, ctx) => {
    const src = (await downloadToSessionCache(ctx.scopeId, fileId, await fetchPresignedUrl(fileId, ctx.idToken), MAX_LOCAL_BYTES)).filePath
    const head = await findHead(readFileSync(src).toString('base64'), 'image/png', ctx.tenantId, AbortSignal.timeout(60_000))
    const dir = mkdtempSync(join(tmpdir(), 'remake-crop-'))
    try {
      const [w, h] = aspectRatio.split(':').map(Number)
      const out = await cropImageLocal(src, join(dir, 'crop.jpg'), framing, head, { aspect: w / h, scaleBack: true })
      const id = await uploadFileWithKey(ctx.idToken, { key: generatedFileKey(ctx.conversationId ?? ctx.runId, `remake ${ctx.runId} still crop ${framing}`, 'jpg'), name: 'Remake still (closer).jpg', content: readFileSync(out), contentType: 'image/jpeg' })
      if (!id?.fileId) throw new Error('crop upload returned no file')
      return id.fileId
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  cutBoard: async (fileId, n, aspectRatio, ctx) => {
    const src = (await downloadToSessionCache(ctx.scopeId, fileId, await fetchPresignedUrl(fileId, ctx.idToken), MAX_LOCAL_BYTES)).filePath
    const dir = mkdtempSync(join(tmpdir(), 'remake-board-'))
    try {
      const [w, h] = aspectRatio.split(':').map(Number)
      const parts = await cutPanels(src, n, w / h, join(dir, 'photo'))
      if (!parts) return null
      const ids = await Promise.all(parts.map(async (p, i) => (await uploadFileWithKey(ctx.idToken, { key: generatedFileKey(ctx.conversationId ?? ctx.runId, `remake ${ctx.runId} board photo ${i + 1}`, 'png'), name: `Remake still ${i + 1}.png`, content: readFileSync(p), contentType: 'image/png' }))?.fileId ?? null))
      return ids.every(Boolean) ? (ids as string[]) : null
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  promptGate: ({ tenantId, ...input }) => runGate(promptCheckScorer, 'prompt', { ...input, tenantId }, []),
  stillChecks: (ask, still, opts) => remakeStillChecks(ask, still, opts),
  sameSetting: (ask, a, b) => sameSetting(ask, a, b),
  ffmpeg: async (args) => { await execFile('ffmpeg', ['-y', '-v', 'error', ...args], { timeout: 120_000 }) },
  readFile: (path) => readFileSync(path),
  renderPreview: (job) => renderPreview(job),
  imageRateMicro: async () => {
    const rate = await resolveRate('image_generation', imageModelFor('gemini').rateSubject)
    return rate ? costMicro(rate.schema, { count: 1 }) : null
  },
  generateVeoClip: (input, exec, index) => generateVeoClipItem(input, exec, index),
  generateOmniClip: async (input, exec, index) => {
    const r = await generateVideoItem({ mode: 'animate_frame', prompt: input.prompt, aspectRatio: input.aspectRatio, durationSeconds: input.durationSeconds, startImageFileId: input.startImageFileId, title: input.title }, exec, index)
    return r as { fileId?: string; refused?: boolean; refusalReason?: string; insufficientCredits?: boolean; creditsUsedMicro?: string }
  },
  poseClip: (path, seconds) => aiService<PoseResult>('/media/pose', { path, looks: [{ label: 'clip', start_s: 0, end_s: seconds }] }),
  sample: async (path, times) => {
    const dir = mkdtempSync(join(tmpdir(), 'remake-sample-'))
    try { return await sampleFrames(path, times, dir) } finally { rmSync(dir, { recursive: true, force: true }) }
  },
  fitToFrames: (i, f, o, s) => fitClipToFrames(i, f, o, s),
  clipRateMicro: async (engine) => {
    const rate = await resolveRate('video_generation', engine === 'veo' ? VEO_CLIP_MODEL : VIDEO_MODEL)
    return rate ? costMicro(rate.schema, { count: 1 }) : null
  },
  musicRateMicro: async () => {
    const rate = await resolveRate('music_generation', 'lyria-002')
    return rate ? costMicro(rate.schema, { count: 1 }) : null
  },
  generateMusic: (prompt, exec, runKey) => generateSongItem({ prompt, title: 'Remake music' }, exec, runKey),
  compare: (breakdown, remakeFileId, ctx, tenantId) => compareToReference({ fileId: breakdown.video.fileId }, remakeFileId, ctx, tenantId, breakdown),
  stillToFrames: (s, f, o, size) => stillToFrames(s, f, o, size),
  joinSegments: (p, o, size) => joinClips(p, o, size),
  fitMusic: (m, s, o) => fitMusicToLength(m, s, o),
  muxMusic: (v, m, o) => setOnlyAudio(v, m, o),
  tempDir: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
  removeDir: (path) => { try { rmSync(path, { recursive: true, force: true }) } catch { /* best effort */ } },
  deleteFile: (idToken, fileId) => deleteFile(idToken, fileId),
}

let override: Partial<RemakeDeps> | null = null
export function setRemakeDeps(d: Partial<RemakeDeps> | null): void { override = d }
export function remakeDeps(): RemakeDeps { return override ? { ...real, ...override } : real }
