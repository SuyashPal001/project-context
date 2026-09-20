import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { fetchPresignedUrl, downloadToSessionCache } from './mediaCache.js'
import { refundAssemblyCharge } from './assemblyCredits.js'
import { shouldRequireApproval } from './generationApproval.js'

const execFile = promisify(execFileCb)

const ASSEMBLY_SUBJECT = 'ffmpeg-local'
// Matches media.ts's FFMPEG_TIMEOUT_MS pattern, sized generously for a
// 3-clip concat rather than the single-clip frame-extraction case that file
// times out at 60s.
const FFMPEG_TIMEOUT_MS = 60_000
// Matches analyzeVideo.ts's MAX_VIDEO_BYTES cap — same class of input.
const MAX_CLIP_BYTES = 200 * 1024 * 1024

const outputSchema = z.object({
  fileId: z.string().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  jobId: z.string().optional(),
})

// Exported as the raw Zod schema (not just accessible via assembleClips.inputSchema)
// so callers/tests can .safeParse()/.parse() it directly — omitting this export broke
// `pnpm type-check` in an earlier task and had to be fixed in review; don't repeat it.
export const inputSchema = z.object({
  clipFileIds: z.array(z.string()).min(1).max(3),
  targetDurationSeconds: z.number().optional().describe(
    'When set, the assembled video is trimmed (extra tail dropped) or the final frame held (tpad) to match this length — used to align the silent clip total to the narration track length.'
  ),
  aspectRatio: z.enum(['16:9', '9:16']),
})

export const assembleClips = createTool({
  id: 'assemble-clips',
  description: 'Concatenates an ordered list of silent video clips into one video, normalized to a constant frame rate and fixed aspect ratio. Shared infra for talking-head and short-drama-stitch — not talking-head-specific.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: ASSEMBLY_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { clipFileIds, targetDurationSeconds, aspectRatio } = inputData as z.infer<typeof inputSchema>

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${toolCallId}`

    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }

    const scopeId = tenantId || sessionId
    const localPaths: string[] = []
    try {
      for (const fileId of clipFileIds) {
        const presignedUrl = await fetchPresignedUrl(fileId, idToken)
        const { filePath } = await downloadToSessionCache(scopeId, fileId, presignedUrl, MAX_CLIP_BYTES)
        localPaths.push(filePath)
      }
    } catch (err) {
      console.error(`[session:${sessionId}] assembleClips: failed to download a clip:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    // Charge BEFORE running ffmpeg — same settled ordering as every other
    // generation tool, even though this is local compute, not a vendor call:
    // consistent charge-before-work ordering means a crash mid-ffmpeg-run
    // behaves the same way (refund path, not a silent free run) as a crash
    // mid-vendor-call elsewhere.
    const attempt = 0
    const chargeKey = `assembly:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('clip_assembly', ASSEMBLY_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED CLIP ASSEMBLY: no active clip_assembly rate tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({
            tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'clip_assembly',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true, jobId }
          throw err
        }
      }
    }

    const workDir = mkdtempSync(join(tmpdir(), 'assemble-'))
    const outputPath = join(workDir, 'assembled.mp4')
    try {
      // Normalizes every clip to CFR 30fps, a fixed aspect ratio, and strips
      // any audio stream (-an on each input leg) before concatenating — the
      // lip-sync step supplies the only audio that matters downstream, and
      // concat fails outright if inputs disagree on stream presence.
      const [w, h] = aspectRatio === '9:16' ? ['1080', '1920'] : ['1920', '1080']
      const filterParts = localPaths.map((_, i) =>
        `[${i}:v]fps=30,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`
      )
      const concatInputs = localPaths.map((_, i) => `[v${i}]`).join('')
      const filterComplex = `${filterParts.join('; ')}; ${concatInputs}concat=n=${localPaths.length}:v=1:a=0[outv]`

      const args: string[] = ['-y']
      for (const p of localPaths) args.push('-i', p)
      args.push('-filter_complex', filterComplex, '-map', '[outv]', '-an')
      if (targetDurationSeconds !== undefined) {
        args.push('-vf', `tpad=stop_mode=clone:stop_duration=${Math.max(0, targetDurationSeconds)}`, '-t', String(targetDurationSeconds))
      }
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', outputPath)

      await execFile('ffmpeg', args, { timeout: FFMPEG_TIMEOUT_MS })
    } catch (err) {
      console.error(`[session:${sessionId}] assembleClips: ffmpeg failed:`, (err as Error).message)
      if (charged) await refundAssemblyCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'ASSEMBLY_FAILED', jobId }
    }

    if (!conversationId) {
      if (charged) await refundAssemblyCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    const buffer = readFileSync(outputPath)
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Assembled Video', content: buffer,
      contentType: 'video/mp4', extension: 'mp4',
    })
    rmSync(workDir, { recursive: true, force: true })

    if (!attachment) {
      if (charged) await refundAssemblyCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})
