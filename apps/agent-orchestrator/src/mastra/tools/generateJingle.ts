import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { stableToolCallId } from '../../credits.js'
import { fileTitleSchema, fileTitle } from './fileTitle.js'
import { refundMusicCharge } from './musicCredits.js'
import { shouldRequireApproval } from './generationApproval.js'
import { emitGenerationStarted } from './generationStarted.js'
import { videoBlockedThisTurn, SHOW_FIRST_FOLLOW_ON_REFUSAL } from './oneVideoPerTurn.js'
import { findLine, parseTimedLyrics, type TimedLine } from './timedLyrics.js'
import { cutSignoff } from './jingleCut.js'

// A sung sign-off for the TVC ad (spec 2026-10-05-tvc-jingle-design.md J3).
// Its own tool, so Director never confuses a bed (generate_song, instrumental
// lyria-002) with a jingle. Lyria 3 sings the given lines and returns timed
// lyrics; the sign-off line is found and cut in code, not by the agent.
const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
export const JINGLE_MODEL = 'lyria-3-clip-preview'

export function jinglePrompt(style: string, language?: string): string {
  return language?.trim() ? `${style}. Sung in ${language.trim()}.` : style
}

const lineSchema = z.object({ start: z.number(), end: z.number(), text: z.string() })

export const jingleInputSchema = z.object({
  line: z.string().min(1).max(80).describe('The sung sign-off, e.g. "Bubbli, feel the magic"'),
  lyrics: z.array(z.string().min(1)).max(4).optional().describe('Extra lines sung before the sign-off'),
  style: z.string().min(1).describe('Genre, mood and voice, e.g. "bright pop, female vocal, 120 bpm"'),
  language: z.string().optional().describe('The language it is sung in, when not English, e.g. "Hindi"'),
  title: fileTitleSchema,
})

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  signoffFileId: z.string().optional(),
  signoffSeconds: z.number().optional(),
  lines: z.array(lineSchema).optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
})

export const generateJingle = createTool({
  id: 'generate-jingle',
  description: 'Paid. Makes a short SUNG jingle with Lyria 3: it sings the given lyrics and then the sign-off line, in any language, and returns the full ~30s clip plus the sign-off cut out of it (signoffFileId, signoffSeconds) ready to mix over the ending. Use only for a sung sign-off; instrumental music is generate_song.',
  inputSchema: jingleInputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    !videoBlockedThisTurn(ctx?.requestContext) && shouldRequireApproval({ resourceType: 'music_generation', subject: JINGLE_MODEL }, ctx),
  execute: async (inputData, execContext) => {
    if (videoBlockedThisTurn(execContext?.requestContext)) return SHOW_FIRST_FOLLOW_ON_REFUSAL
    const { line, lyrics, style, language, title } = inputData as z.infer<typeof jingleInputSchema>
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    if (!conversationId || !idToken) return { refused: true, refusalReason: 'NO_SESSION_CONTEXT' }
    emitGenerationStarted(execContext)

    // Charge BEFORE the vendor call (same as generate_song); every failure
    // below refunds. A Gemini 3.x toolCallId can be several KB, so it is
    // hashed before it goes into a ledger key (CLAUDE.md).
    const toolCallId = execContext?.agent?.toolCallId
    const chargeKey = `jingle:${conversationId}:${toolCallId ? stableToolCallId(toolCallId) : randomUUID()}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('music_generation', JINGLE_MODEL)
      if (!rate) {
        console.error(`[credits] UNBILLED JINGLE: no active music_generation rate for model=${JINGLE_MODEL} tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        try {
          await spendCredits({
            tenantId, amountMicro: -costMicro(rate.schema, { count: 1 }), key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'music_generation',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true }
          throw err
        }
      }
    }
    const refund = async () => { if (charged) await refundMusicCharge(tenantId, agentId, chargeKey, rateId, rateVersion) }

    let gen: { audioBase64?: string; mimeType?: string; lyricsText?: string; refused?: boolean; reason?: string }
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/music/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ model: JINGLE_MODEL, prompt: jinglePrompt(style, language), lyrics: [...(lyrics ?? []), line] }),
        signal: AbortSignal.timeout(120_000),
      })
      if (!res.ok) {
        if (res.status === 422) {
          const body = await res.json().catch(() => ({})) as { error?: { message?: string } }
          await refund()
          return { refused: true, refusalReason: `PROMPT_REJECTED: ${body?.error?.message ?? 'Lyria could not sing this.'}` }
        }
        throw new Error(`gateway returned ${res.status}`)
      }
      gen = await res.json()
    } catch (err) {
      console.error(`[session:${conversationId}] generateJingle gateway call failed:`, (err as Error).message)
      await refund()
      return { refused: true, refusalReason: 'GENERATION_FAILED' }
    }
    if (gen.refused) {
      await refund()
      return { refused: true, refusalReason: gen.reason ?? 'GENERATION_FAILED' }
    }
    if (typeof gen.audioBase64 !== 'string') {
      await refund()
      return { refused: true, refusalReason: 'GENERATION_FAILED' }
    }

    const lines: TimedLine[] = parseTimedLyrics(gen.lyricsText ?? '')
    const sung = findLine(lines, line)
    if (!sung) {
      await refund()
      return { refused: true, refusalReason: `JINGLE_LINE_NOT_SUNG: Lyria did not sing "${line}"; try once more or shorten the line`, lines }
    }

    const full = Buffer.from(gen.audioBase64, 'base64')
    const mimeType = gen.mimeType ?? 'audio/mpeg'
    let cut: { audio: Buffer; seconds: number }
    let workDir: string | undefined
    try {
      workDir = mkdtempSync(join(tmpdir(), 'jingle-'))
      const fullPath = join(workDir, 'full.mp3')
      writeFileSync(fullPath, full)
      cut = await cutSignoff(fullPath, sung, workDir)
    } catch (err) {
      console.error(`[session:${conversationId}] generateJingle cut failed:`, (err as Error).message)
      await refund()
      return { refused: true, refusalReason: 'JINGLE_CUT_FAILED' }
    } finally {
      // A cleanup error here must never mask a successful cut or skip the
      // refund on a failed one — mkdtempSync/writeFileSync/cutSignoff errors
      // are already handled above; this is best-effort tidy-up only.
      if (workDir) { try { rmSync(workDir, { recursive: true, force: true }) } catch { /* best effort */ } }
    }

    const name = fileTitle(title, 'Jingle')
    const fullFile = await uploadGeneratedFile(idToken, { conversationId, title: name, content: full, contentType: mimeType, extension: 'mp3' })
    if (!fullFile) { await refund(); return { refused: true, refusalReason: 'STORAGE_FAILED' } }
    const signoffFile = await uploadGeneratedFile(idToken, { conversationId, title: `${name} sign-off`, content: cut.audio, contentType: 'audio/mp4', extension: 'm4a' })
    if (!signoffFile) { await refund(); return { refused: true, refusalReason: 'STORAGE_FAILED' } }

    return {
      fileId: fullFile.fileId, name: fullFile.name, fileType: fullFile.type, size: fullFile.size,
      signoffFileId: signoffFile.fileId, signoffSeconds: cut.seconds, lines,
    }
  },
})
