// Every side effect of a remake run, behind one seam so the workflow is testable
// without a gateway, a model, a store or ffmpeg.
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { costMicro, resolveRate } from '@serverless-saas/credits'
import { generateImageItem, type ImageItemInput } from '../tools/generateImage.js'
import type { MediaExecContext } from '../tools/batchRunner.js'
import { gatewayAsk, runStillChecks, type AskFn, type Img } from '../tools/tvcChecks.js'
import { fetchBase64 } from '../tools/checkClip.js'
import { fetchPresignedUrl, downloadToSessionCache } from '../tools/mediaCache.js'
import { uploadFileWithKey } from '../../persistence.js'
import { aiService, type ImagePose } from '../tools/videoBreakdown/aiServiceClient.js'
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
  promptGate: (input: ReturnType<typeof stillGateInput> & { tenantId: string }) => Promise<CheckResult>
  stillChecks: (ask: AskFn, still: Img, opts: { lead?: Img; leadInShot?: boolean }) => Promise<{ passed: boolean; reasons: string[] }>
  ffmpeg: (args: string[]) => Promise<void>
  readFile: (path: string) => Buffer
  renderPreview: (job: PreviewJob) => Promise<string>
  imageRateMicro: () => Promise<bigint | null>
}

const real: RemakeDeps = {
  ask: (tenantId) => gatewayAsk(tenantId, fetch, checkModel(), REMAKE_COST),
  generateStill: (input, exec, index) => generateImageItem(input, exec, index),
  fetchImage: (fileId, idToken) => fetchBase64(fileId, idToken, AbortSignal.timeout(120_000)),
  localFile: async (fileId, idToken, scopeId) => (await downloadToSessionCache(scopeId, fileId, await fetchPresignedUrl(fileId, idToken), MAX_LOCAL_BYTES)).filePath,
  upload: async (idToken, key, name, content, contentType) => (await uploadFileWithKey(idToken, { key, name, content, contentType }))?.fileId ?? null,
  poseImage: (path) => aiService<ImagePose>('/media/pose-image', { path }),
  promptGate: ({ tenantId, ...input }) => runGate(promptCheckScorer, 'prompt', { ...input, tenantId }, []),
  stillChecks: (ask, still, opts) => runStillChecks(ask, still, opts),
  ffmpeg: async (args) => { await execFile('ffmpeg', ['-y', '-v', 'error', ...args], { timeout: 120_000 }) },
  readFile: (path) => readFileSync(path),
  renderPreview: (job) => renderPreview(job),
  imageRateMicro: async () => {
    const rate = await resolveRate('image_generation', imageModelFor('gemini').rateSubject)
    return rate ? costMicro(rate.schema, { count: 1 }) : null
  },
}

let override: Partial<RemakeDeps> | null = null
export function setRemakeDeps(d: Partial<RemakeDeps> | null): void { override = d }
export function remakeDeps(): RemakeDeps { return override ? { ...real, ...override } : real }
