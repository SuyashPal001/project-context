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
// 4-clip concat (plus an AAC encode step when preserveAudio is set) rather
// than the single-clip frame-extraction case that file times out at 60s.
const FFMPEG_TIMEOUT_MS = 60_000
// Matches analyzeVideo.ts's MAX_VIDEO_BYTES cap — same class of input.
const MAX_CLIP_BYTES = 200 * 1024 * 1024

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
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
  clipFileIds: z.array(z.string()).min(1).max(4),
  targetDurationSeconds: z.number().positive().optional().describe(
    'When set, the assembled video is trimmed (extra tail dropped) or the final frame held (tpad) to match this length — used to align this clip total to a separate audio track\'s length. Not compatible with preserveAudio (see refine below) — animation-character\'s preserveAudio callers pre-trim every clip upstream and never set this.'
  ),
  preserveAudio: z.boolean().default(false).describe(
    'When true, concatenates with each input\'s audio stream preserved (v=1:a=1, each stream resampled to a common format first) instead of stripping all audio (-an). Every input must already carry an audio stream, already trimmed to its final length — this field does not itself trim anything. Default false keeps talking-head/short-drama-stitch\'s existing silent-concat-then-lipsync behavior unchanged.'
  ),
  aspectRatio: z.enum(['16:9', '9:16']),
}).refine(
  (v) => !(v.preserveAudio && v.targetDurationSeconds !== undefined),
  { message: 'preserveAudio and targetDurationSeconds cannot both be set — the concat filter graph produces one video+audio output stream, and stop_duration padding is meaningless once every input is already individually trimmed upstream' },
)

export const assembleClips = createTool({
  id: 'assemble-clips',
  description: 'Concatenates an ordered list of video clips into one video, normalized to a constant frame rate and fixed aspect ratio. Silent by default (audio stripped); pass preserveAudio: true to keep and normalize each clip\'s own audio track instead. Shared infra for talking-head, short-drama-stitch, and animation-character — not talking-head-specific.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: ASSEMBLY_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { clipFileIds, targetDurationSeconds, preserveAudio, aspectRatio } = inputData as z.infer<typeof inputSchema>

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

    let workDir: string
    try {
      workDir = mkdtempSync(join(tmpdir(), 'assemble-'))
    } catch (err) {
      console.error(`[session:${sessionId}] assembleClips: failed to create temp dir:`, (err as Error).message)
      if (charged) await refundAssemblyCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'ASSEMBLY_FAILED', jobId }
    }
    const outputPath = join(workDir, 'assembled.mp4')
    try {
      // Normalizes every clip to CFR 30fps and a fixed aspect ratio. Audio
      // is stripped (-an) unless preserveAudio is set, matching talking-head/
      // short-drama-stitch's existing silent-concat-then-lipsync flow by
      // default. The inputSchema's refine above guarantees preserveAudio
      // and targetDurationSeconds are never both set, so the concat label
      // is always unambiguous: exactly one shared output when preserveAudio
      // is false, exactly one video+audio pair when it's true.
      const [w, h] = aspectRatio === '9:16' ? ['1080', '1920'] : ['1920', '1080']

      const videoFilterParts = localPaths.map((_, i) =>
        `[${i}:v]fps=30,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`
      )

      let filterComplex: string
      let concatInputs: string
      if (preserveAudio) {
        // concat requires every input segment to agree on sample rate,
        // channel layout and sample format — our real inputs are
        // heterogeneous (fal.ai's lip-synced MP4, our own AAC mux, and an
        // untouched -c:a copy from composite_end_card), so each audio
        // stream is resampled/reformatted to one common shape BEFORE
        // concat, not fed in raw.
        const audioFilterParts = localPaths.map((_, i) =>
          `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
        )
        concatInputs = localPaths.map((_, i) => `[v${i}][a${i}]`).join('')
        filterComplex = `${videoFilterParts.join('; ')}; ${audioFilterParts.join('; ')}; ${concatInputs}concat=n=${localPaths.length}:v=1:a=1[outv][outa]`
      } else {
        concatInputs = localPaths.map((_, i) => `[v${i}]`).join('')
        // tpad must be chained inside the same filter_complex graph, not applied
        // via a separate -vf flag — ffmpeg refuses to mix simple (-vf) and
        // complex (-filter_complex) filtering on the same output stream. When a
        // target duration is set, concat writes to an intermediate [cat] label
        // and tpad consumes that to produce the final [outv].
        // Note: stop_duration below pads BY the target amount (not TO it) — the
        // trailing -t flag is what truncates the result to the actual target
        // duration. Correct only because both are present; dropping -t while
        // keeping tpad as-is would silently produce an over-long output.
        const concatLabel = targetDurationSeconds !== undefined ? '[cat]' : '[outv]'
        filterComplex = `${videoFilterParts.join('; ')}; ${concatInputs}concat=n=${localPaths.length}:v=1:a=0${concatLabel}`
        if (targetDurationSeconds !== undefined) {
          filterComplex += `; [cat]tpad=stop_mode=clone:stop_duration=${Math.max(0, targetDurationSeconds)}[outv]`
        }
      }

      const args: string[] = ['-y']
      for (const p of localPaths) args.push('-i', p)
      args.push('-filter_complex', filterComplex, '-map', '[outv]')
      if (preserveAudio) {
        args.push('-map', '[outa]')
      } else {
        args.push('-an')
      }
      if (!preserveAudio && targetDurationSeconds !== undefined) {
        args.push('-t', String(targetDurationSeconds))
      }
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p')
      if (preserveAudio) args.push('-c:a', 'aac')
      args.push(outputPath)

      await execFile('ffmpeg', args, { timeout: FFMPEG_TIMEOUT_MS })
    } catch (err) {
      console.error(`[session:${sessionId}] assembleClips: ffmpeg failed:`, (err as Error).message)
      if (charged) await refundAssemblyCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      // preserveAudio callers must hand in clips that already carry audio —
      // if one doesn't, ffmpeg's filtergraph binding fails with this exact
      // message ("Stream specifier ':a' in filtergraph description ...
      // matches no streams", confirmed against a live run, not guessed).
      // Distinct from the generic bucket so a caller building on this tool
      // can tell "you gave me a silent clip" apart from any other ffmpeg
      // failure.
      const stderr = (err as { stderr?: string }).stderr ?? ''
      if (preserveAudio && stderr.includes('matches no streams')) {
        return { refused: true, refusalReason: 'MISSING_AUDIO_STREAM', jobId }
      }
      return { refused: true, refusalReason: 'ASSEMBLY_FAILED', jobId }
    }

    if (!conversationId) {
      if (charged) await refundAssemblyCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    let buffer: Buffer
    try {
      buffer = readFileSync(outputPath)
    } catch (err) {
      console.error(`[session:${sessionId}] assembleClips: failed to read assembled output:`, (err as Error).message)
      if (charged) await refundAssemblyCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'ASSEMBLY_FAILED', jobId }
    }
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
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})
