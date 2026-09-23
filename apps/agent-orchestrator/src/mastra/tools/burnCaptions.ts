import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { fetchPresignedUrl, downloadToSessionCache } from './mediaCache.js'
import { refundBurnCaptionsCharge } from './burnCaptionsCredits.js'
import { shouldRequireApproval } from './generationApproval.js'
import { stableToolCallId } from '../../credits.js'

const execFile = promisify(execFileCb)

const CAPTIONS_SUBJECT = 'ffmpeg-burn-captions'
const FFMPEG_TIMEOUT_MS = 60_000
const MAX_SOURCE_BYTES = 200 * 1024 * 1024
// Phrase-grouped, not word-by-word — matches the genre look the spec
// describes (novoads' "changing per phrase rather than per word").
const WORDS_PER_PHRASE = 4

export interface TranscribedWord {
  word: string
  startSeconds: number
  endSeconds: number
}

export interface CaptionPhrase {
  text: string
  startSeconds: number
  endSeconds: number
}

export function groupWordsIntoPhrases(words: TranscribedWord[], groupSize: number): CaptionPhrase[] {
  if (groupSize <= 0) throw new Error(`groupWordsIntoPhrases: groupSize must be positive, got ${groupSize}`)
  const phrases: CaptionPhrase[] = []
  for (let i = 0; i < words.length; i += groupSize) {
    const chunk = words.slice(i, i + groupSize)
    phrases.push({
      text: chunk.map((w) => w.word).join(' '),
      startSeconds: chunk[0].startSeconds,
      endSeconds: chunk[chunk.length - 1].endSeconds,
    })
  }
  return phrases
}

// SRT format requires HH:MM:SS,mmm — this is the standard SRT cue
// timestamp, not a caption-styling concern.
export function formatSrtTimestamp(seconds: number): string {
  // Clamp negative input — a malformed transcript (e.g. a bad ASR offset)
  // must not produce a negative HH:MM:SS,mmm, which is unparseable as SRT.
  const totalMs = Math.round(Math.max(0, seconds) * 1000)
  const h = Math.floor(totalMs / 3_600_000)
  const m = Math.floor((totalMs % 3_600_000) / 60_000)
  const s = Math.floor((totalMs % 60_000) / 1_000)
  const ms = totalMs % 1_000
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`
}

// Writing an SRT file and burning it via ffmpeg's `subtitles` filter (not
// a raw `drawtext` chain) is the fix for a real defect an earlier draft
// had: drawtext's text= value is delimited by single quotes in the filter
// string, so an escaped `\'` for an apostrophe in the caption text (e.g.
// "it's", "don't" — both common in narration) actually TERMINATES that
// quoted section early and breaks the whole filter graph. SRT text needs
// no such escaping — the subtitles filter parses it as its own file
// format, not as an inline filter-string argument.
export function buildSrt(phrases: CaptionPhrase[]): string {
  return phrases
    .map((p, i) => `${i + 1}\n${formatSrtTimestamp(p.startSeconds)} --> ${formatSrtTimestamp(p.endSeconds)}\n${p.text}\n`)
    .join('\n')
}

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

// Exported raw so a test can call .safeParse directly — see this plan's
// Global Constraints.
export const inputSchema = z.object({
  videoFileId: z.string().describe('The voice-mixed master to caption.'),
  words: z.array(z.object({
    word: z.string(),
    startSeconds: z.number(),
    endSeconds: z.number(),
  })).min(1).describe('Word-level timings from transcribe_audio — captions are burned from these, not from the original script.'),
})

export const burnCaptions = createTool({
  id: 'burn-captions',
  description: 'Burns phrase-grouped captions onto a video, timed from transcribe_audio\'s real word timings — never from the original script, since the render can drop or add a word. One fixed style: heavy sans-serif, white fill, dark outline, lower third.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: CAPTIONS_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { videoFileId, words } = inputData as z.infer<typeof inputSchema>

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${stableToolCallId(toolCallId)}`

    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }

    const scopeId = tenantId || sessionId
    let videoPath: string
    try {
      const videoUrl = await fetchPresignedUrl(videoFileId, idToken)
      ;({ filePath: videoPath } = await downloadToSessionCache(scopeId, videoFileId, videoUrl, MAX_SOURCE_BYTES))
    } catch (err) {
      console.error(`[session:${sessionId}] burnCaptions: failed to download source:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    const attempt = 0
    const chargeKey = `burn-captions:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('clip_assembly', CAPTIONS_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED BURN-CAPTIONS: no active clip_assembly/${CAPTIONS_SUBJECT} rate tenantId=${tenantId} — generation was NOT charged`)
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
      workDir = mkdtempSync(join(tmpdir(), 'captions-'))
    } catch (err) {
      console.error(`[session:${sessionId}] burnCaptions: failed to create temp dir:`, (err as Error).message)
      if (charged) await refundBurnCaptionsCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'CAPTION_FAILED', jobId }
    }
    const outputPath = join(workDir, 'captioned.mp4')
    try {
      const phrases = groupWordsIntoPhrases(words, WORDS_PER_PHRASE)
      const srtPath = join(workDir, 'captions.srt')
      writeFileSync(srtPath, buildSrt(phrases))
      // ffmpeg's subtitles filter argument treats ':' and '\' specially in
      // the FILTER STRING (not inside the SRT file itself) — escape the
      // path defensively even though mkdtempSync under os.tmpdir() won't
      // produce one on this deployment's Linux/macOS hosts.
      const escapedSrtPath = srtPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
      // Lower-third placement, white fill, thick dark outline — matches
      // the genre look novoads' caption presets describe. force_style
      // overrides the SRT's own (absent) styling; MarginV keeps the band
      // clear of most safe-area UI overlays at any resolution.
      // FontName assumes DejaVu Sans is installed on the deployment host;
      // if it isn't, libass/fontconfig falls back silently to whatever
      // default font fontconfig picks — no error, just a different look.
      // Revisit if production captions look wrong.
      const forceStyle = "FontName=DejaVu Sans,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Alignment=2,MarginV=80"
      await execFile('ffmpeg', [
        '-y', '-i', videoPath,
        '-vf', `subtitles=${escapedSrtPath}:force_style='${forceStyle}'`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        outputPath,
      ], { timeout: FFMPEG_TIMEOUT_MS })
    } catch (err) {
      console.error(`[session:${sessionId}] burnCaptions: ffmpeg failed:`, (err as Error).message)
      if (charged) await refundBurnCaptionsCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      // Distinct from the generic bucket so a caller/operator debugging a
      // production deployment can tell "this host's ffmpeg has no libass"
      // apart from any other ffmpeg failure — same pattern as
      // assembleClips.ts's MISSING_AUDIO_STREAM. Verified live against a
      // real libass-less ffmpeg (8.1.2, this machine's default Homebrew
      // build): with the filter given as `subtitles=<path>:force_style=...`
      // (this tool's exact invocation — args always present), the actual
      // stderr is "Error parsing filterchain 'subtitles=...'" / "No option
      // name near '<path>'" — NOT "Unknown filter 'subtitles'.", which is
      // only what `ffmpeg -h filter=subtitles` prints, or what a bare
      // `-vf subtitles` (no `=args`, never this tool's shape) fails with
      // ("No such filter: 'subtitles'"). Matching on the args-present form
      // plus the bare-filter form covers both real shapes across ffmpeg
      // versions without matching unrelated filtergraph errors.
      const stderr = (err as { stderr?: string }).stderr ?? ''
      if (
        stderr.includes("filterchain 'subtitles=") ||
        stderr.includes("No such filter: 'subtitles'") ||
        stderr.includes("Unknown filter 'subtitles'")
      ) {
        return { refused: true, refusalReason: 'SUBTITLES_FILTER_UNAVAILABLE', jobId }
      }
      return { refused: true, refusalReason: 'CAPTION_FAILED', jobId }
    }

    if (!conversationId) {
      if (charged) await refundBurnCaptionsCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    let buffer: Buffer
    try {
      buffer = readFileSync(outputPath)
    } catch (err) {
      console.error(`[session:${sessionId}] burnCaptions: failed to read output:`, (err as Error).message)
      if (charged) await refundBurnCaptionsCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'CAPTION_FAILED', jobId }
    }
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Captioned Video', content: buffer,
      contentType: 'video/mp4', extension: 'mp4',
    })
    rmSync(workDir, { recursive: true, force: true })

    if (!attachment) {
      if (charged) await refundBurnCaptionsCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})
