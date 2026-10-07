import { createTool } from '@mastra/core/tools'
import { FIRST_VOICE_REFUSAL, firstVoiceUnreviewed, noteNarrationMade } from './reviewGate.js'
import { z } from 'zod'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { refundNarrationCharge } from './narrationCredits.js'
import { shouldRequireApproval } from './generationApproval.js'
import { stableToolCallId } from '../../credits.js'
import { emitToolStatus } from './generationStarted.js'
import { checkNarrationVoice } from './narrationVoice.js'
import { videoBlockedThisTurn, SHOW_FIRST_FOLLOW_ON_REFUSAL } from './oneVideoPerTurn.js'

function languageName(code: string): string {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code } catch { return code }
}

const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
// Narration runs on Gemini 3.8 Flash TTS (won every listening test against
// Cartesia, 2026-10-03). Cartesia voice ids are UUIDs and still route to
// Cartesia, so chats that picked a Cartesia voice before the switch keep working.
export const GEMINI_SPEECH_MODEL = 'gemini-3.8-flash-tts'
export const CARTESIA_SPEECH_MODEL = 'sonic-3.5'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Measured on Gemini 3.8 voice-note reads (2026-10-03: 33 words in 12.0s at
// speed 1.05, about 2.75 words a second); vocal tags are not words.
const WORDS_PER_SECOND = 2.7
const LENGTH_TOLERANCE_SECONDS = 1.5
export function scriptShortfall(script: string, targetSeconds: number | undefined): string | null {
  if (!targetSeconds) return null
  const words = script.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length
  const estimated = words / WORDS_PER_SECOND
  if (estimated >= targetSeconds - LENGTH_TOLERANCE_SECONDS) return null
  const needed = Math.round(targetSeconds * WORDS_PER_SECOND)
  return `SCRIPT_TOO_SHORT: ${words} words reads in about ${Math.round(estimated)}s, but the ad is ${targetSeconds}s. Rewrite the script to about ${needed} words (same voice and tone), show it to the user, then narrate.`
}

export function narrationModel(voiceId: string | undefined): string {
  return voiceId && UUID_RE.test(voiceId) ? CARTESIA_SPEECH_MODEL : GEMINI_SPEECH_MODEL
}

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  durationSeconds: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  jobId: z.string().optional(),
  model: z.string().optional(),
})

export const inputSchema = z.object({
  script: z.string().max(500).describe(
    'The full narration script — one continuous read, not pre-split into clip-sized segments. ~500 characters is roughly 30-35 seconds of speech at typical ad pacing, matching this skill\'s 30s ceiling.'
  ),
  voiceId: z.string().describe('A voice id, from the existing curated voice list.'),
  language: z.string().optional().describe('BCP-47 or ISO language code for the narration read (e.g. "hi", "ja", "es"). Omit for English.'),
  emotion: z.enum(['enthusiastic', 'excited', 'happy', 'content', 'calm', 'confident', 'curious', 'grateful', 'affectionate', 'surprised', 'sympathetic', 'contemplative', 'determined', 'proud', 'neutral', 'sad', 'nostalgic', 'wistful']).optional().describe(
    'Delivery emotion for the whole read (English only; ignored for other languages). Pick it from the ad\'s tone and make sure the words actually carry it — e.g. enthusiastic for UGC/testimonial energy, content or calm for wellness, confident for a pitch. Omit for a neutral read.'
  ),
  speed: z.number().min(0.6).max(1.5).optional().describe('Speech speed, 1.0 is normal. ~1.05 for lively UGC, 0.95 for calm/premium. Omit for 1.0.'),
  targetSeconds: z.number().positive().max(60).optional().describe(
    'The ad length the user asked for, in seconds. When set, a script too short to fill it is refused before any charge, with the word count needed.'
  ),
  direction: z.string().max(600).optional().describe(
    'How the line should be performed, in plain English — who is speaking, to whom, and how (e.g. "Not a voice actor: an ordinary woman in her mid-twenties recording a casual voice note to her best friend. Relaxed, a bit fast, a smile you can hear, sentence ends trailing off, uneven pauses, never polished."). Never put this in the script — it is sent separately and never spoken. Works in every language. Takes priority over emotion/speed.'
  ),
})

export const generateNarration = createTool({
  id: 'generate-narration',
  description: 'Generates a narration/voiceover audio clip from a script — an audio track produced separately from the video, not native in-render speech. Use for talking-head\'s single continuous narration track (one call, full script), and for animation-character\'s per-beat VO lines (one call per beat, each beat\'s single line, muxed or lip-synced onto that beat\'s silent clip afterward) — not for dialogue spoken natively by generate_video\'s own render. Write the script for the ear, not the page: numbers and symbols as spoken words ("a hundred percent", never "100%"), commas and full stops where a person would breathe, no <break> tags (they make the read sound stitched). Set emotion and speed to match the ad\'s tone. Voices are Gemini voices: always pass a plain-English direction for the performance, and you may put at most one or two vocal tags right in the script where a real person would make the sound — <breath>, <laugh>, <sigh>, <short pause>.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    !videoBlockedThisTurn(ctx?.requestContext) && !firstVoiceUnreviewed(ctx?.requestContext) && shouldRequireApproval({ resourceType: 'narration_generation', subject: narrationModel((_input as { voiceId?: string } | undefined)?.voiceId) }, ctx),
  execute: async (inputData, execContext) => {
    if (videoBlockedThisTurn(execContext?.requestContext)) return SHOW_FIRST_FOLLOW_ON_REFUSAL
    if (firstVoiceUnreviewed(execContext?.requestContext)) return FIRST_VOICE_REFUSAL
    const { script, voiceId, language, emotion, speed, direction, targetSeconds } = inputData as z.infer<typeof inputSchema>
    const SPEECH_MODEL = narrationModel(voiceId)

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    // Left undefined, never '' — see generateVideo.ts's identical comment:
    // spendCredits' actorId does `?? null` internally so undefined casts
    // cleanly to ::uuid, but '' hits Postgres as ''::uuid and throws.
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${stableToolCallId(toolCallId)}`

    // Before any charge: a script that can't fill the requested length is
    // rewritten, not recorded (a 15s ad came back 12s on 2026-10-03).
    const shortfall = scriptShortfall(script, targetSeconds)
    if (shortfall) return { refused: true, refusalReason: shortfall, jobId }

    // Before any charge: refuse a voice that is not currently offered.
    const voiceCheck = await checkNarrationVoice(voiceId)
    if (!voiceCheck.ok) return { refused: true, refusalReason: `VOICE_NOT_AVAILABLE: ${voiceCheck.reason}`, jobId }

    // Charge BEFORE the vendor call — same settled rule generateVideo.ts
    // follows. generateSong.ts charges after and is a known-divergent tool,
    // not a template.
    const attempt = 0
    const chargeKey = `narration:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('narration_generation', SPEECH_MODEL)
      if (!rate) {
        console.error(`[credits] UNBILLED NARRATION GENERATION: no active narration_generation rate for model=${SPEECH_MODEL} tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({
            tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'narration_generation',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true, jobId }
          throw err
        }
      }
    }

    // Same live line the casting tools show — the read itself is the wait here,
    // so the card says what is being recorded instead of a generic "Preparing…".
    const opening = script.trim().replace(/\s+/g, ' ')
    emitToolStatus(execContext, 'Recording narration', [
      `"${opening.length > 60 ? `${opening.slice(0, 60).trimEnd()}…` : opening}"`,
      ...(language && language !== 'en' ? [`Read in ${languageName(language)}`] : []),
    ])

    let genResult: { audioBase64?: string; mimeType?: string; durationSeconds?: number; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ model: SPEECH_MODEL, transcript: script, voiceId, ...(language ? { language } : {}), ...(emotion ? { emotion } : {}), ...(speed ? { speed } : {}), ...(direction ? { direction } : {}) }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) throw new Error(`gateway returned ${res.status}`)
      genResult = await res.json()
    } catch (err) {
      console.error(`[session:${sessionId}] generateNarration gateway call failed:`, (err as Error).message)
      if (charged) await refundNarrationCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    if (genResult.refused) {
      if (charged) await refundNarrationCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: genResult.reason ?? 'unknown', jobId }
    }

    if (typeof genResult.audioBase64 !== 'string' || typeof genResult.durationSeconds !== 'number') {
      console.error(`[session:${sessionId}] generateNarration: gateway returned a non-refused response with no audioBase64/durationSeconds`)
      if (charged) await refundNarrationCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'GENERATION_FAILED', jobId }
    }

    // A zero/garbage durationSeconds is a malformed response, not a valid short
    // clip — left unchecked it flows into downstream clipCount math
    // (Math.ceil(duration/10)) as 0, surfacing only much later as an
    // assemble_clips min(1) rejection after the paid board gate has already run.
    if (!(genResult.durationSeconds > 0.5)) {
      console.error(`[session:${sessionId}] generateNarration: gateway returned an invalid durationSeconds (${genResult.durationSeconds})`)
      if (charged) await refundNarrationCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'INVALID_DURATION', jobId }
    }

    if (!conversationId || !idToken) {
      if (charged) await refundNarrationCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    const buffer = Buffer.from(genResult.audioBase64, 'base64')
    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: 'Generated Narration', content: buffer,
      contentType: genResult.mimeType ?? 'audio/wav', extension: 'wav',
    })

    if (!attachment) {
      if (charged) await refundNarrationCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    noteNarrationMade(execContext?.requestContext?.get('conversationId') as string | undefined)
    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      durationSeconds: genResult.durationSeconds,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      model: SPEECH_MODEL,
      jobId,
    }
  },
})
