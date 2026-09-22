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
// Matches media.ts's FFMPEG_TIMEOUT_MS pattern, sized generously for an
// 8-clip xfade concat with real uploaded footage (short-drama-stitch) —
// raised from 60s (sized for skill 4/5's shorter generated clips) to 180s.
const FFMPEG_TIMEOUT_MS = 180_000
// Raised from 200MB (sized for skill 4/5's generated clips) to 500MB —
// short-drama-stitch's inputs are real uploaded camera footage, where a
// single clip well over 200MB is ordinary.
const MAX_CLIP_BYTES = 500 * 1024 * 1024

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

// A zero-width transition is `type: 'cut'`, never an xfade with
// overlapSeconds 0 or omitted — verified live against real ffmpeg: video
// `xfade duration=0` silently drops the second clip entirely (exit 0, no
// error), and audio `acrossfade d=0` falls through to `nb_samples`'s
// ~0.92s default, the opposite of zero. A flat object + .superRefine
// (not z.discriminatedUnion, which nothing else in this codebase's tool
// schemas uses and which Mastra's JSON-Schema conversion for model
// function-calling has not been verified against) keeps every rejection
// reason as a named, greppable message.
//
// `name` is a fixed enum, not a free-form string, deliberately deviating
// from the plan's original `z.string().min(1)` — a code-reviewer proved
// this is a real filter-graph injection: `name` gets interpolated
// unvalidated into the ffmpeg `-filter_complex` string
// (`xfade=transition=${name}:...`), and a payload like
// `"fade[zz]; movie=red.mp4,fps=30,...[inj]; [zz][inj]xfade=transition=fadeblack"`
// closes the xfade filter early and injects a second filter chain that
// reads an arbitrary local file via ffmpeg's `movie=` source — a real
// local-file-read primitive on the orchestrator machine. Since `name`
// only ever comes from a model-chosen value (directorAgent's future
// wiring), constraining it to real ffmpeg xfade transition names both
// closes the injection and gives the model a clear valid-values list.
const XFADE_TRANSITION_NAMES = ['fade', 'wipeleft', 'wiperight', 'slideleft', 'slideright', 'circlecrop', 'dissolve', 'fadeblack', 'fadewhite'] as const
const transitionEntrySchema = z.object({
  type: z.enum(['xfade', 'cut']),
  name: z.enum(XFADE_TRANSITION_NAMES).optional(),
  overlapSeconds: z.number().optional(),
}).superRefine((v, ctx) => {
  if (v.type === 'xfade') {
    if (!v.name) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'INVALID_TRANSITION_OVERLAP: xfade entries require a name (e.g. "fade")' })
    }
    if (v.overlapSeconds === undefined || v.overlapSeconds <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'INVALID_TRANSITION_OVERLAP: xfade entries require overlapSeconds > 0 — never 0 or omitted, use type "cut" for a zero-width transition instead' })
    }
  } else if (v.overlapSeconds !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'INVALID_TRANSITION_OVERLAP: a cut entry must not carry overlapSeconds' })
  }
})

// Exported as the raw Zod schema (not just accessible via assembleClips.inputSchema)
// so callers/tests can .safeParse()/.parse() it directly — omitting this export broke
// `pnpm type-check` in an earlier task and had to be fixed in review; don't repeat it.
export const inputSchema = z.object({
  clipFileIds: z.array(z.string()).min(1).max(8),
  targetDurationSeconds: z.number().positive().optional().describe(
    'When set, the assembled video is trimmed (extra tail dropped) or the final frame held (tpad) to match this length — used to align this clip total to a separate audio track\'s length. Not compatible with preserveAudio (see refine below) — animation-character\'s preserveAudio callers pre-trim every clip upstream and never set this.'
  ),
  preserveAudio: z.boolean().default(false).describe(
    'When true, concatenates with each input\'s audio stream preserved (v=1:a=1, each stream resampled to a common format first) instead of stripping all audio (-an). Every input must already carry an audio stream, already trimmed to its final length — this field does not itself trim anything. Default false keeps talking-head/short-drama-stitch\'s existing silent-concat-then-lipsync behavior unchanged.'
  ),
  transitions: z.array(transitionEntrySchema).optional().describe(
    'Per-boundary transitions, length must equal clipFileIds.length - 1. Only consumed when preserveAudio is true (short-drama-stitch use case) — every clip pair gets either an xfade crossfade (with a positive overlapSeconds) or a hard cut.'
  ),
  aspectRatio: z.enum(['16:9', '9:16']),
}).refine(
  (v) => !(v.preserveAudio && v.targetDurationSeconds !== undefined),
  { message: 'preserveAudio and targetDurationSeconds cannot both be set — the concat filter graph produces one video+audio output stream, and stop_duration padding is meaningless once every input is already individually trimmed upstream' },
).refine(
  (v) => !v.transitions || v.transitions.length === v.clipFileIds.length - 1,
  { message: 'TRANSITION_COUNT_MISMATCH: transitions.length must equal clipFileIds.length - 1, one entry per boundary between consecutive clips' },
).refine(
  (v) => !v.transitions || v.preserveAudio,
  { message: 'TRANSITION_REQUIRES_AUDIO: transitions can only be set when preserveAudio is true — footage keeps its own audio in the short-drama-stitch use case this exists for' },
)

interface TransitionEntry {
  type: 'xfade' | 'cut'
  name?: typeof XFADE_TRANSITION_NAMES[number]
  overlapSeconds?: number
}

// xfade/acrossfade are strictly pairwise with an absolute `offset`
// (relative to the first input) — there is no n-way form like concat has.
// This walks the boundary list left to right, accumulating a running
// duration, and builds a sequential filter graph: each xfade boundary
// joins the accumulated stream to the next clip with an absolute offset;
// each cut boundary concats them instead (concat=n=2, not batched with
// neighbors — simpler and still correct at this skill's <=8-clip scale).
// Confirmed live and correct for the xfade-then-cut case during spec
// review: three 3s clips, one 1s xfade then one cut, produced exactly
// 8.06s.
//
// settb fix (found during plan review, live-verified): feeding a
// concat filter's video output directly into a LATER xfade fails —
// ffmpeg 8.1.2 rejects it with "First input link main timebase ...
// do not match ... xfade timebase" and produces no output at all (exit
// 234). Every non-final concat's video output is re-based with
// settb=1/30 before it's used as an xfade input. A live 4-clip/3-boundary
// [cut, xfade(1s), cut] run with this fix produced 11.074s for four 3s
// clips — matching the arithmetic 9.0s (=3*4-1 overlap second... actually
// 12 - 1 = 11, quantization accounts for the rest).
function buildTransitionsFilterComplex(
  videoLabels: string[], // ['v0', 'v1', ...] — already-normalized per-input labels
  audioLabels: string[], // ['a0', 'a1', ...]
  durations: number[],   // ffprobed VIDEO-stream duration per input, same order
  transitions: TransitionEntry[],
): string {
  let accV = videoLabels[0]
  let accA = audioLabels[0]
  let accDuration = durations[0]
  const parts: string[] = []

  for (let i = 0; i < transitions.length; i++) {
    const boundary = transitions[i]
    const nextV = videoLabels[i + 1]
    const nextA = audioLabels[i + 1]
    const nextDuration = durations[i + 1]
    const isLast = i === transitions.length - 1
    const outV = isLast ? 'outv' : `accv${i}`
    const outA = isLast ? 'outa' : `acca${i}`

    if (boundary.type === 'xfade') {
      const overlap = boundary.overlapSeconds!
      const offset = accDuration - overlap
      if (offset < 0) {
        // The AI-proposed or user-given overlap is larger than the
        // accumulated stream it's crossfading against — ffmpeg accepts a
        // negative offset silently and produces a garbled result rather
        // than erroring, so this must be caught here, before ffmpeg ever
        // runs.
        throw new Error(`INVALID_TRANSITION_OVERLAP: boundary ${i}'s overlapSeconds (${overlap}) exceeds the accumulated clip duration (${accDuration}) it would crossfade against`)
      }
      parts.push(`[${accV}][${nextV}]xfade=transition=${boundary.name}:duration=${overlap}:offset=${offset}[${outV}]`)
      parts.push(`[${accA}][${nextA}]acrossfade=d=${overlap}[${outA}]`)
      accDuration = accDuration + nextDuration - overlap
    } else {
      const isFollowedByXfade = !isLast && transitions[i + 1].type === 'xfade'
      const concatVideoOut = isFollowedByXfade ? `${outV}raw` : outV
      parts.push(`[${accV}][${accA}][${nextV}][${nextA}]concat=n=2:v=1:a=1[${concatVideoOut}][${outA}]`)
      if (isFollowedByXfade) {
        parts.push(`[${concatVideoOut}]settb=1/30[${outV}]`)
      }
      accDuration = accDuration + nextDuration
    }
    accV = outV
    accA = outA
  }

  return parts.join('; ')
}

export const assembleClips = createTool({
  id: 'assemble-clips',
  description: 'Concatenates an ordered list of video clips into one video, normalized to a constant frame rate and fixed aspect ratio. Silent by default (audio stripped); pass preserveAudio: true to keep and normalize each clip\'s own audio track instead. Shared infra for talking-head, short-drama-stitch, and animation-character — not talking-head-specific.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: ASSEMBLY_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { clipFileIds, targetDurationSeconds, preserveAudio, aspectRatio, transitions } = inputData as z.infer<typeof inputSchema>

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
      if (transitions && transitions.length > 0) {
        // Every input is ffprobed for its own VIDEO-stream duration
        // specifically — NOT `format=duration` (the container's overall
        // duration, which is the MAX of all streams). Real uploaded
        // footage routinely has audio and video streams of different
        // lengths; probing the container duration and using it as the
        // xfade offset produced a live-verified, silently WRONG offset
        // (exit 0, no error) with several seconds of A/V desync in the
        // final output — this is the exact silent-failure class this
        // skill's overlapSeconds validation was written to close, and it
        // would have been reopened here by the wrong probe field.
        const durations: number[] = []
        for (const p of localPaths) {
          const { stdout: durOut } = await execFile('ffprobe', [
            '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', p,
          ], { timeout: FFMPEG_TIMEOUT_MS })
          const d = parseFloat(durOut.trim())
          if (!(d > 0)) throw new Error(`ffprobe returned an invalid video-stream duration for an input clip: ${durOut}`)
          durations.push(d)
        }
        const audioFilterParts = localPaths.map((_, i) =>
          `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
        )
        const videoLabels = localPaths.map((_, i) => `v${i}`)
        const audioLabels = localPaths.map((_, i) => `a${i}`)
        const transitionsGraph = buildTransitionsFilterComplex(videoLabels, audioLabels, durations, transitions as TransitionEntry[])
        filterComplex = `${videoFilterParts.join('; ')}; ${audioFilterParts.join('; ')}; ${transitionsGraph}`
      } else if (preserveAudio) {
        // concat requires every input segment to agree on sample rate,
        // channel layout and sample format — our real inputs are
        // heterogeneous (fal.ai's lip-synced MP4, our own AAC mux, and an
        // untouched -c:a copy from composite_end_card), so each audio
        // stream is resampled/reformatted to one common shape BEFORE
        // concat, not fed in raw.
        const audioFilterParts = localPaths.map((_, i) =>
          `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
        )
        const concatInputs = localPaths.map((_, i) => `[v${i}][a${i}]`).join('')
        filterComplex = `${videoFilterParts.join('; ')}; ${audioFilterParts.join('; ')}; ${concatInputs}concat=n=${localPaths.length}:v=1:a=1[outv][outa]`
      } else {
        const concatInputs = localPaths.map((_, i) => `[v${i}]`).join('')
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
      const message = (err as Error).message ?? ''
      if (message.startsWith('INVALID_TRANSITION_OVERLAP')) {
        return { refused: true, refusalReason: 'INVALID_TRANSITION_OVERLAP', jobId }
      }
      const stderr = (err as { stderr?: string }).stderr ?? ''
      if (preserveAudio && stderr.includes('matches no streams')) {
        return { refused: true, refusalReason: 'MISSING_AUDIO_STREAM', jobId }
      }
      // Confirmed live (ffmpeg 8.1.2) against an invalid xfade `transition`
      // name: ffmpeg does NOT report "unknown transition" — it fails while
      // binding the `transition` option itself with "Error applying option
      // 'transition' to filter 'xfade': Not yet implemented in FFmpeg,
      // patches welcome" (exit 176). Matched on the option-binding prefix,
      // which is specific to xfade's `transition` option regardless of
      // which invalid name triggered it.
      if (transitions && transitions.length > 0 && stderr.includes("Error applying option 'transition' to filter 'xfade'")) {
        return { refused: true, refusalReason: 'XFADE_FILTER_FAILED', jobId }
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
