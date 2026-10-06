import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { fetchPresignedUrl, downloadToSessionCache } from './mediaCache.js'

// Free: the real cut times of a reference ad (ffmpeg scene detection), so a
// recreation follows its edit rhythm instead of guessed timings (spec P6).
const execFile = promisify(execFileCb)
const MAX_SOURCE_BYTES = 300 * 1024 * 1024

export function parseShowinfoCuts(stderr: string): number[] {
  return [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Math.round(Number(m[1]) * 100) / 100).filter((n) => n > 0)
}

export interface CutTimesResult { cutTimes: number[]; durationSeconds: number }

// Shared by the detect_cuts tool and plan_tvc check (spec Task 4): the plan
// must never trust Director's own cutTimes, only what ffmpeg finds in the
// reference file itself. Cached within the process so a Director re-check
// loop doesn't re-run ffmpeg on every plan_tvc call.
//
// Keyed by scopeId + videoFileId + threshold, not videoFileId alone:
// - scopeId (the tenant, falling back to conversationId) means a cache hit
//   can never answer with another tenant's detection of the "same" fileId.
// - threshold is Director-controlled on the detect_cuts tool (0.05-0.9). A
//   cache keyed only by videoFileId let Director call detect_cuts once at
//   threshold 0.9 (few cuts), poisoning the entry plan_tvc then reused to
//   pass a plan with fewer shots than the real 0.25 cut count. plan_tvc
//   itself never accepts a threshold from Director — see planTvc.ts, which
//   always calls detectCutTimes with the default.
const MAX_CACHE_ENTRIES = 200
const cutTimesCache = new Map<string, Promise<CutTimesResult>>()

function cacheKey(scopeId: string, videoFileId: string, threshold: number): string {
  return `${scopeId}:${videoFileId}:${threshold}`
}

async function detectCutTimesUncached(videoFileId: string, idToken: string, scopeId: string, threshold: number): Promise<CutTimesResult> {
  const url = await fetchPresignedUrl(videoFileId, idToken)
  const { filePath } = await downloadToSessionCache(scopeId, videoFileId, url, MAX_SOURCE_BYTES)
  const { stderr } = await execFile('ffmpeg', ['-hide_banner', '-i', filePath, '-filter:v', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'], { timeout: 180_000, maxBuffer: 32 * 1024 * 1024 })
  const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { timeout: 30_000 })
  return { cutTimes: parseShowinfoCuts(stderr), durationSeconds: Math.round(parseFloat(stdout.trim()) * 100) / 100 }
}

export function detectCutTimes(videoFileId: string, idToken: string, scopeId: string, threshold = 0.25): Promise<CutTimesResult> {
  const key = cacheKey(scopeId, videoFileId, threshold)
  const cached = cutTimesCache.get(key)
  if (cached) return cached
  const promise = detectCutTimesUncached(videoFileId, idToken, scopeId, threshold)
  promise.catch(() => cutTimesCache.delete(key))
  cutTimesCache.set(key, promise)
  // Map iteration order is insertion order: the first key is the oldest.
  if (cutTimesCache.size > MAX_CACHE_ENTRIES) {
    const oldest = cutTimesCache.keys().next().value
    if (oldest !== undefined) cutTimesCache.delete(oldest)
  }
  return promise
}

export const detectCuts = createTool({
  id: 'detect-cuts',
  description: 'Free: finds the real cut times (scene changes) in a reference video, for recreating its edit timing. Set brief.reference.videoFileId in the TVC plan instead of writing cutTimes yourself — plan_tvc check reads the cuts from the file.',
  inputSchema: z.object({
    videoFileId: z.string().describe('The reference video'),
    threshold: z.number().min(0.05).max(0.9).default(0.25).describe('Scene-change sensitivity; 0.25 matched the 2026-10-05 reference ad'),
  }),
  outputSchema: z.object({
    cutTimes: z.array(z.number()).optional(),
    durationSeconds: z.number().optional(),
    refused: z.boolean().optional(),
    refusalReason: z.string().optional(),
  }),
  execute: async (inputData, execContext) => {
    const { videoFileId, threshold } = inputData as { videoFileId: string; threshold: number }
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined ?? 'unknown'
    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE' }
    try {
      return await detectCutTimes(videoFileId, idToken, tenantId || conversationId, threshold)
    } catch (err) {
      console.error('[detectCuts] failed:', (err as Error).message)
      return { refused: true, refusalReason: 'DETECT_CUTS_FAILED' }
    }
  },
})
