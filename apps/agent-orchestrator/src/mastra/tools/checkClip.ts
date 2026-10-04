import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fetchPresignedUrl } from './mediaCache.js'
import { resolveAvatarReferences } from './avatarReferences.js'
import { persistCost } from '../cost.js'

// Checks a finished talking-head clip before it is used: is it still the same
// person, and did they say the approved line? 2026-10-03: a clip started from
// a faceless crop and the video model invented a different man; nothing caught
// it before the clips were joined. Free to the user (one small model call).
const execFile = promisify(execFileCb)
const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const MODEL = 'gemini-3.6-flash'
const TIMEOUT_MS = 90_000
// gemini-3.6-flash thinks before answering and the thinking counts against
// max_tokens: at 400 it stopped mid-JSON (MAX_TOKENS, 2026-10-05) and every
// check came back "unreadable verdict". 4000 leaves room for both.
const MAX_TOKENS = 4000
const LINE_MATCH_THRESHOLD = 0.85

const normalise = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean)

/** Share of the approved line's words heard, in order (0..1). */
export function lineMatchScore(expected: string, heard: string): number {
  const want = normalise(expected), got = normalise(heard)
  if (want.length === 0) return 1
  let i = 0
  for (const word of got) if (i < want.length && word === want[i]) i++
  // Order-insensitive fallback so one misheard word does not block the rest.
  const gotSet = new Set(got)
  const present = want.filter((w) => gotSet.has(w)).length
  return Math.max(i, present) / want.length
}

export interface ClipVerdict { samePerson: boolean; productSame: boolean; glitch: boolean; confidence: number; heard: string; reason: string }

// Asked point by point, against the master still (it carries this ad's exact
// outfit). A plain "same person?" question let gemini-3.6-flash pass a clip
// with a different man in a different shirt at 10/10 (tested 2026-10-03); the
// strict comparison caught it and still passed the good clip.
export const STRICT_QUESTION = 'You are a strict continuity checker for a video ad. Image A is the master still of the presenter at the start of this ad; any further reference images show the same presenter. Then come frames from a later clip. Compare carefully, point by point: (1) clothing (garment type, colour, collar), (2) hair, (3) face shape and jaw, (4) eyes and brows, (5) nose, (6) age. (7) glitches: a duplicated or extra product, extra hands or fingers, or an object that jumps between hands or appears from nowhere. A different-looking person, the same-looking person in different clothes, or a visible glitch is a FAIL.'

/** Pulls the JSON verdict out of the model's reply; null when unusable. */
export function parseVerdict(raw: string): ClipVerdict | null {
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const v = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
    // Strict form: clothing_same + face_same; plain form: samePerson.
    const same = typeof v.face_same === 'boolean'
      ? v.face_same && v.clothing_same !== false
      : v.samePerson
    if (typeof same !== 'boolean') return null
    return { samePerson: same, productSame: v.product_same !== false, glitch: v.glitch === true, confidence: Number(v.confidence ?? 0), heard: String(v.heard ?? ''), reason: String(v.differences ?? v.reason ?? '') }
  } catch {
    return null
  }
}

// What each clip was first checked against, per conversation. 2026-10-05:
// when check_clip errored, Director called it again without the line, the
// product and the avatar until it "passed" — a clip compared only with its
// own start image always passes, so a cut-off line and a different face both
// got through. A re-check may add inputs, never drop them.
type CheckInputs = { expectedLine: boolean; product: boolean; reference: boolean }
const checkedWith = new Map<string, CheckInputs>()
export function droppedCheckInputs(key: string, now: CheckInputs): string[] {
  const before = checkedWith.get(key)
  const dropped = before
    ? (['expectedLine', 'product', 'reference'] as const).filter((k) => before[k] && !now[k])
    : []
  if (dropped.length === 0) {
    if (checkedWith.size > 1000) checkedWith.delete(checkedWith.keys().next().value as string)
    checkedWith.set(key, {
      expectedLine: now.expectedLine || !!before?.expectedLine,
      product: now.product || !!before?.product,
      reference: now.reference || !!before?.reference,
    })
  }
  return dropped
}

async function fetchBase64(fileId: string, idToken: string, signal: AbortSignal): Promise<{ data: string; mime: string }> {
  const url = new URL(await fetchPresignedUrl(fileId, idToken, signal))
  url.searchParams.delete('x-amz-checksum-mode')
  const res = await fetch(url.toString(), { signal })
  if (!res.ok) throw new Error(`fetch ${fileId}: ${res.status}`)
  return { data: Buffer.from(await res.arrayBuffer()).toString('base64'), mime: res.headers.get('content-type') ?? 'image/jpeg' }
}

export const checkClip = createTool({
  id: 'check-clip',
  description: 'Free check of a finished clip (or a still image, before it is animated) before it is used: compares a frame with the presenter\'s reference images (same person?) and the clip\'s speech with the approved line (said it?). Call it after every clip; if passed is false, regenerate that clip once, and if it fails again, stop and tell Olmo why instead of using it.',
  inputSchema: z.object({
    clipFileId: z.string().describe('The generated clip to check, or a still image (checked as one frame, no audio)'),
    masterStillFileId: z.string().describe("This ad's locked master still — the outfit and look every clip must keep"),
    referenceFileIds: z.array(z.string()).max(1).optional().describe('Optional: the avatar, whose reference sheet is then added automatically'),
    expectedLine: z.string().optional().describe('The exact approved line this clip should speak; omit for a silent clip'),
    productFileId: z.string().optional().describe('The product photo, when the product appears in the clip: its shape, colour and printed/embroidered text must stay the same'),
  }),
  outputSchema: z.object({
    passed: z.boolean().optional(),
    samePerson: z.boolean().optional(),
    lineMatches: z.boolean().optional(),
    productMatches: z.boolean().optional(),
    glitch: z.boolean().optional(),
    heard: z.string().optional(),
    reason: z.string().optional(),
    refused: z.boolean().optional(),
    refusalReason: z.string().optional(),
  }),
  execute: async (inputData, execContext) => {
    const { clipFileId, masterStillFileId, referenceFileIds, expectedLine, productFileId } = inputData as { clipFileId: string; masterStillFileId: string; referenceFileIds?: string[]; expectedLine?: string; productFileId?: string }
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE' }
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined ?? ''
    const dropped = droppedCheckInputs(`${conversationId}:${clipFileId}`, { expectedLine: !!expectedLine, product: !!productFileId, reference: !!referenceFileIds?.length })
    if (dropped.length) {
      return { refused: true, refusalReason: `CHECK_INPUTS_DROPPED: this clip was checked before with ${dropped.join(', ')}; check it again with the same inputs (never fewer) — a check without them proves nothing` }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const workDir = mkdtempSync(join(tmpdir(), 'check-clip-'))
    try {
      const clip = await fetchBase64(clipFileId, idToken, controller.signal)
      // A still (a beat's image before it is animated) is checked as one frame,
      // with no audio.
      const isStill = clip.mime.startsWith('image/')
      const frames: Array<{ data: string; mime: string }> = []
      let audio: string | null = null
      if (isStill) frames.push({ data: clip.data, mime: clip.mime })
      else {
      const clipPath = join(workDir, 'clip.mp4')
      writeFileSync(clipPath, Buffer.from(clip.data, 'base64'))
      const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clipPath], { timeout: 30_000 })
      const duration = Number(stdout.trim()) || 4
      // Three frames: just after the start (Omni's glitches — a second bottle,
      // a hand swap — show in the first second), the middle, and near the end,
      // where drift shows up.
      for (const [i, t] of [Math.min(0.7, duration * 0.1), duration * 0.5, Math.max(0, duration - 0.3)].entries()) {
        const out = join(workDir, `f${i}.jpg`)
        await execFile('ffmpeg', ['-y', '-ss', String(t), '-i', clipPath, '-frames:v', '1', '-q:v', '3', out], { timeout: 30_000 })
        frames.push({ data: readFileSync(out).toString('base64'), mime: 'image/jpeg' })
      }
      if (expectedLine) {
        const out = join(workDir, 'a.wav')
        await execFile('ffmpeg', ['-y', '-i', clipPath, '-vn', '-ac', '1', '-ar', '16000', out], { timeout: 30_000 })
        audio = readFileSync(out).toString('base64')
      }
      }
      const refIds = referenceFileIds?.length ? (await resolveAvatarReferences(tenantId, referenceFileIds)).fileIds.slice(0, 2) : []
      const master = await fetchBase64(masterStillFileId, idToken, controller.signal)
      const refs = await Promise.all(refIds.map((id) => fetchBase64(id, idToken, controller.signal)))

      const content: unknown[] = [{ type: 'text', text: 'Image A (master still):' }, { type: 'image_url', image_url: { url: `data:${master.mime};base64,${master.data}` } }]
      if (refs.length) content.push({ type: 'text', text: 'Reference images:' })
      for (const r of refs) content.push({ type: 'image_url', image_url: { url: `data:${r.mime};base64,${r.data}` } })
      if (productFileId) {
        const product = await fetchBase64(productFileId, idToken, controller.signal)
        content.push({ type: 'text', text: 'Image P (the product):' }, { type: 'image_url', image_url: { url: `data:${product.mime};base64,${product.data}` } })
      }
      content.push({ type: 'text', text: 'Frames from the later clip:' })
      for (const f of frames) content.push({ type: 'image_url', image_url: { url: `data:${f.mime};base64,${f.data}` } })
      if (audio) {
        content.push({ type: 'text', text: 'The clip\'s audio:' })
        content.push({ type: 'input_audio', input_audio: { data: audio, format: 'wav' } })
      }
      const productAsk = productFileId ? 'Also check the product wherever it is visible in the clip frames: same shape, colour and brand name as Image P (product_same false if it is a different product, a different shape or colour, or the brand name is clearly misspelled or garbled; ignore small print, which video always blurs; true if it is not visible). ' : ''
      content.push({ type: 'text', text: STRICT_QUESTION + ' ' + productAsk + (audio ? 'Also transcribe exactly what is spoken in the audio. ' : '') + 'Reply with ONLY JSON: {"clothing_same": true|false, "face_same": true|false, ' + (productFileId ? '"product_same": true|false, ' : '') + '"glitch": true|false, "confidence": 1-10, "differences": "<short list or none>", "heard": "<exact transcript or empty>"}' })

      const res = await fetch(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
        body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content }] }),
      })
      if (!res.ok) return { refused: true, refusalReason: `CHECK_FAILED: gateway ${res.status}` }
      const result = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
      if (tenantId && result.usage) {
        persistCost({ tenantId, agentId: 'check-clip', workflowId: 'media-understanding', model: MODEL, inputTokens: result.usage.prompt_tokens ?? 0, outputTokens: result.usage.completion_tokens ?? 0 })
      }
      const verdict = parseVerdict(result.choices?.[0]?.message?.content ?? '')
      if (!verdict) return { refused: true, refusalReason: 'CHECK_FAILED: unreadable verdict' }
      const lineMatches = expectedLine && audio ? lineMatchScore(expectedLine, verdict.heard) >= LINE_MATCH_THRESHOLD : true
      const samePerson = verdict.samePerson && verdict.confidence >= 6
      const productMatches = verdict.productSame
      const noGlitch = !verdict.glitch
      return {
        passed: samePerson && lineMatches && productMatches && noGlitch,
        samePerson,
        lineMatches,
        productMatches,
        glitch: verdict.glitch,
        heard: verdict.heard,
        reason: !samePerson ? `Different person: ${verdict.reason}` : !productMatches ? `Product changed: ${verdict.reason}` : !noGlitch ? `Visible glitch: ${verdict.reason}` : !lineMatches ? `Did not say the approved line (heard: "${verdict.heard}")` : 'Same person, product and line.',
      }
    } catch (err) {
      console.error('[checkClip] failed:', (err as Error).message)
      return { refused: true, refusalReason: 'CHECK_FAILED' }
    } finally {
      clearTimeout(timer)
      rmSync(workDir, { recursive: true, force: true })
    }
  },
})
