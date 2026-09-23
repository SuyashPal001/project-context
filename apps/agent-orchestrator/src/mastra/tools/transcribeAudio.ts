import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { fetchPresignedUrl, downloadToSessionCache } from './mediaCache.js'
import { refundTranscribeAudioCharge } from './transcribeAudioCredits.js'
import { shouldRequireApproval } from './generationApproval.js'
import { stableToolCallId } from '../../credits.js'

const execFile = promisify(execFileCb)

const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const TRANSCRIBE_SUBJECT = 'gemini-transcribe'
const FFMPEG_TIMEOUT_MS = 60_000
const MAX_SOURCE_BYTES = 200 * 1024 * 1024
// Mirrors the gateway's MAX_TRANSCRIBE_AUDIO_BYTES (transcribe.ts) — checked
// here too so an oversized extraction is refused before spendCredits runs,
// not after.
const MAX_TRANSCRIBE_AUDIO_BYTES = 20 * 1024 * 1024

const outputSchema = z.object({
  text: z.string().optional(),
  words: z.array(z.object({
    word: z.string(),
    startSeconds: z.number(),
    endSeconds: z.number(),
  })).optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  jobId: z.string().optional(),
})

// Exported raw so a test can call .safeParse directly — see this plan's
// Global Constraints.
export const inputSchema = z.object({
  fileId: z.string().describe('The voice-mixed master (a video file) to transcribe with word-level timings.'),
})

export const transcribeAudio = createTool({
  id: 'transcribe-audio',
  description: 'Transcribes a video\'s spoken audio into text plus per-word start/end timings, via Gemini. Used to burn word-accurate captions and to verify brand names weren\'t garbled — distinct from analyze_audio, which returns a plain transcript with no word timings.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'audio_transcription', subject: TRANSCRIBE_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { fileId } = inputData as z.infer<typeof inputSchema>

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
      const videoUrl = await fetchPresignedUrl(fileId, idToken)
      ;({ filePath: videoPath } = await downloadToSessionCache(scopeId, fileId, videoUrl, MAX_SOURCE_BYTES))
    } catch (err) {
      console.error(`[session:${sessionId}] transcribeAudio: failed to download source:`, (err as Error).message)
      return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }
    }

    // Extract audio-only BEFORE charging — a local, free operation, and
    // extraction failure means there's nothing to transcribe regardless of
    // payment. Sending the full video to Gemini (rather than this
    // extracted track) would exceed its inline-request size ceiling — see
    // Task 2's revision note.
    let workDir: string | undefined
    let audioBase64: string
    try {
      workDir = mkdtempSync(join(tmpdir(), 'transcribe-'))
      const audioPath = join(workDir, 'audio.aac')
      await execFile('ffmpeg', ['-y', '-i', videoPath, '-vn', '-c:a', 'aac', audioPath], { timeout: FFMPEG_TIMEOUT_MS })
      audioBase64 = readFileSync(audioPath).toString('base64')
    } catch (err) {
      console.error(`[session:${sessionId}] transcribeAudio: audio extraction failed:`, (err as Error).message)
      if (workDir) rmSync(workDir, { recursive: true, force: true })
      return { refused: true, refusalReason: 'EXTRACTION_FAILED', jobId }
    }
    rmSync(workDir, { recursive: true, force: true })

    // Cheap local check before charging — the extracted file is already on
    // disk, so we can catch an oversized track here rather than charging and
    // then having the gateway refuse, forcing an unnecessary refund cycle.
    const decodedBytes = Math.floor(audioBase64.length * 3 / 4)
    if (decodedBytes > MAX_TRANSCRIBE_AUDIO_BYTES) {
      console.error(`[session:${sessionId}] transcribeAudio: extracted audio exceeds transcription size limit (${decodedBytes} bytes)`)
      return { refused: true, refusalReason: 'EXTRACTION_TOO_LARGE', jobId }
    }

    const attempt = 0
    const chargeKey = `transcribe-audio:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('audio_transcription', TRANSCRIBE_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED TRANSCRIBE-AUDIO: no active audio_transcription/${TRANSCRIBE_SUBJECT} rate tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({
            tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'audio_transcription',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true, jobId }
          throw err
        }
      }
    }

    let genResult: { text?: string; words?: Array<{ word: string; startSeconds: number; endSeconds: number }>; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/audio/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ audioBase64, mimeType: 'audio/aac' }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      genResult = await res.json()
    } catch (err) {
      console.error(`[session:${sessionId}] transcribeAudio gateway call failed:`, (err as Error).message)
      if (charged) await refundTranscribeAudioCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    if (genResult.refused) {
      if (charged) await refundTranscribeAudioCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: genResult.reason ?? 'unknown', jobId }
    }

    if (typeof genResult.text !== 'string' || !Array.isArray(genResult.words)) {
      console.error(`[session:${sessionId}] transcribeAudio: gateway returned a non-refused response with no text/words`)
      if (charged) await refundTranscribeAudioCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    return {
      text: genResult.text,
      words: genResult.words,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})
