import { spokenSoFar } from './spokenScript.js'
import { mispronouncedWords } from './pronunciation.js'
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
import { checkScopeOf, updateCheckRecords, type CheckInputs, type CheckScope } from './tvcCheckRecords.js'
import { markCheckFailed } from './oneVideoPerTurn.js'
import { CheckUnavailableError, gatewayAsk, runNarrowClipChecks, sampleFrames, type NarrowClipResult, type ProductScale } from './tvcChecks.js'

// Checks a finished talking-head clip before it is used: is it still the same
// person, and did they say the approved line? 2026-10-03: a clip started from
// a faceless crop and the video model invented a different man; nothing caught
// it before the clips were joined. Free to the user (one small model call).
const execFile = promisify(execFileCb)
const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const MODEL = 'gemini-3.6-flash'
const TIMEOUT_MS = 90_000
const NARROW_TIMEOUT_MS = 600_000
// gemini-3.6-flash thinks before answering and the thinking counts against
// max_tokens: at 400 it stopped mid-JSON (MAX_TOKENS, 2026-10-05) and every
// check came back "unreadable verdict". 4000 leaves room for both.
const MAX_TOKENS = 4000
const LINE_MATCH_THRESHOLD = 0.85

const normalise = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean)

// Some models return a non-speech placeholder for "heard" on a silent shot
// instead of an empty string — "[music]", "(no speech)", "none" — which must
// count as silence, not as someone speaking.
const SILENT_PLACEHOLDERS = new Set(['none', 'no speech', 'silence', 'n/a'])
function isEffectivelySilent(heard: string): boolean {
  const t = heard.trim()
  if (SILENT_PLACEHOLDERS.has(t.toLowerCase())) return true
  // Strip every bracketed or parenthesised span: "[music] so I tried this
  // [laughs]" still has words in it and is not silence.
  return t.replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim() === ''
}

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

export interface ClipVerdict { samePerson: boolean; productSame: boolean; glitch: boolean; confidence: number; heard: string; reason: string; soundSame: boolean }

// Asked point by point, against the master still (it carries this ad's exact
// outfit). A plain "same person?" question let gemini-3.6-flash pass a clip
// with a different man in a different shirt at 10/10 (tested 2026-10-03); the
// strict comparison caught it and still passed the good clip.
export const STRICT_QUESTION = 'You are a strict continuity checker for a video ad. Image A is the master still of the presenter at the start of this ad; any further reference images show the same presenter. Then come frames from a later clip. Compare carefully, point by point: (1) clothing (garment type, colour, collar), (2) hair, (3) face shape and jaw, (4) eyes and brows, (5) nose, (6) age. (7) glitches: a duplicated or extra product, extra hands or fingers, or an object that jumps between hands or appears from nowhere. A different-looking person, the same-looking person in different clothes, or a visible glitch is a FAIL.'

// A shot with nobody in it (a product macro, a "superpower" shot in a TVC ad):
// there is no presenter to compare, so judge the scene and glitches instead.
export const NO_PERSON_QUESTION = 'You are a strict continuity checker for a video ad. Image A is the approved start still of this shot, which has no person in it (at most a hand). Then come frames from the clip made from it. Compare point by point: (1) the set, surfaces and lighting match Image A, (2) no person\'s face appears, (3) glitches: a duplicated or extra product, extra hands or fingers, or an object that appears from nowhere. A different scene, a face appearing or a visible glitch is a FAIL.'

/** Pulls the JSON verdict out of the model's reply; null when unusable. */
export function parseVerdict(raw: string): ClipVerdict | null {
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const v = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
    // No-person form: scene_same; strict form: clothing_same + face_same; plain form: samePerson.
    const same = typeof v.scene_same === 'boolean'
      ? v.scene_same
      : typeof v.face_same === 'boolean'
        ? v.face_same && v.clothing_same !== false
        : v.samePerson
    if (typeof same !== 'boolean') return null
    return { samePerson: same, productSame: v.product_same !== false, glitch: v.glitch === true, confidence: Number(v.confidence ?? 0), heard: String(v.heard ?? ''), reason: String(v.differences ?? v.reason ?? ''), soundSame: v.same_voice !== false && v.same_room !== false }
  } catch {
    return null
  }
}

// What each clip was first checked against, per conversation. 2026-10-05:
// when check_clip errored, Director called it again without the line, the
// product and the avatar until it "passed" — a clip compared only with its
// own start image always passes, so a cut-off line and a different face both
// got through. A re-check may add inputs, never drop them.
// presenter = the clip was judged as a shot with a person in it. A re-check
// that flips noPerson on drops the face and outfit comparison, so it counts as
// a dropped input like the others; noPerson true -> false is stricter and allowed.
const CHECK_KEYS = ['expectedLine', 'product', 'reference', 'noSpeech', 'presenter', 'productVisible', 'extras', 'lead', 'action', 'endState', 'productNarrow', 'productExpectedState'] as const

/** The re-check rules (unchanged): a re-check may add inputs, never drop them. */
export function mergeCheckInputs(before: CheckInputs | undefined, now: CheckInputs): { dropped: string[]; merged: CheckInputs } {
  const dropped = before ? CHECK_KEYS.filter((k) => before[k] && !now[k]) : []
  const merged: CheckInputs = {
    expectedLine: now.expectedLine || !!before?.expectedLine,
    product: now.product || !!before?.product,
    reference: now.reference || !!before?.reference,
    noSpeech: !!now.noSpeech || !!before?.noSpeech,
    presenter: !!now.presenter || !!before?.presenter,
    productVisible: !!now.productVisible || !!before?.productVisible,
    extras: !!now.extras || !!before?.extras,
    lead: !!now.lead || !!before?.lead,
    action: !!now.action || !!before?.action,
    endState: !!now.endState || !!before?.endState,
    productNarrow: !!now.productNarrow || !!before?.productNarrow,
    productExpectedState: !!now.productExpectedState || !!before?.productExpectedState,
  }
  return { dropped, merged }
}

// Today's in-process record, kept only as the fallback when the thread
// cannot hold the record (missing, foreign, or the store is down).
const fallbackCheckedWith = new Map<string, CheckInputs>()
export function droppedCheckInputsFallback(key: string, now: CheckInputs): string[] {
  const { dropped, merged } = mergeCheckInputs(fallbackCheckedWith.get(key), now)
  if (dropped.length === 0) {
    if (fallbackCheckedWith.size > 1000) fallbackCheckedWith.delete(fallbackCheckedWith.keys().next().value as string)
    fallbackCheckedWith.set(key, merged)
  }
  return dropped
}

/** What a clip was first checked with lives in the thread's metadata (K1). */
export async function droppedCheckInputs(scope: CheckScope, clipFileId: string, now: CheckInputs): Promise<string[]> {
  let dropped: string[] = []
  const out = await updateCheckRecords(scope, (r) => {
    const res = mergeCheckInputs(r.checkedWith[clipFileId], now)
    dropped = res.dropped
    if (dropped.length) return null
    return { ...r, checkedWith: { ...r.checkedWith, [clipFileId]: res.merged }, checkedOrder: [...r.checkedOrder.filter((k) => k !== clipFileId), clipFileId] }
  })
  return out === 'unavailable' ? droppedCheckInputsFallback(`${scope.threadId}:${clipFileId}`, now) : dropped
}

export async function fetchBase64(fileId: string, idToken: string, signal: AbortSignal): Promise<{ data: string; mime: string }> {
  const url = new URL(await fetchPresignedUrl(fileId, idToken, signal))
  url.searchParams.delete('x-amz-checksum-mode')
  const res = await fetch(url.toString(), { signal })
  if (!res.ok) throw new Error(`fetch ${fileId}: ${res.status}`)
  return { data: Buffer.from(await res.arrayBuffer()).toString('base64'), mime: res.headers.get('content-type') ?? 'image/jpeg' }
}

export function buildCheckQuestion(opts: { product: boolean; audio: boolean; noPerson: boolean; silent?: boolean; sound?: boolean }): string {
  const productAsk = opts.product ? 'Also check the product wherever it is visible in the clip frames: same shape, colour and brand name as Image P (product_same false if it is a different product, a different shape or colour, or the brand name is clearly misspelled, garbled or mirrored/written backwards; ignore small print, which video always blurs; true if it is not visible). ' : ''
  // The shipped sentence stays byte-identical for every existing caller
  // (presenter/line checks). The silence wording is an extra sentence, only
  // added when the shot is expected to be silent.
  const audioAsk = opts.audio ? 'Also transcribe exactly what is spoken in the audio. ' : ''
  const silentAsk = opts.audio && opts.silent ? 'If nobody speaks, leave heard empty; ignore music and sound effects. ' : ''
  const soundAsk = opts.sound ? "Also compare the clip's audio with Audio R, ignoring the words: same speaker's voice (same_voice), and same microphone and room — same echo and background sound (same_room)? A dry studio-sounding voice against a roomy one is a different room. " : ''
  const first = opts.noPerson ? '{"scene_same": true|false, ' : '{"clothing_same": true|false, "face_same": true|false, '
  return (opts.noPerson ? NO_PERSON_QUESTION : STRICT_QUESTION) + ' ' + productAsk + audioAsk + silentAsk + soundAsk +
    'Reply with ONLY JSON: ' + first + (opts.product ? '"product_same": true|false, ' : '') + (opts.sound ? '"same_voice": true|false, "same_room": true|false, ' : '') +
    '"glitch": true|false, "confidence": 1-10, "differences": "<short list or none>", "heard": "<exact transcript or empty>"}'
}

export function judgeVerdict(
  v: ClipVerdict,
  opts: { expectedLine?: string; audioChecked: boolean; expectNoSpeech: boolean; noPerson: boolean; soundChecked?: boolean },
): { passed: boolean; samePerson: boolean; lineMatches: boolean; productMatches: boolean; speechOk: boolean; soundMatches: boolean; reason: string } {
  const lineMatches = opts.expectedLine && opts.audioChecked ? lineMatchScore(opts.expectedLine, v.heard) >= LINE_MATCH_THRESHOLD : true
  const samePerson = opts.noPerson ? v.samePerson : v.samePerson && v.confidence >= 6
  const productMatches = v.productSame
  const noGlitch = !v.glitch
  const soundMatches = opts.soundChecked ? v.soundSame : true
  const speechOk = !(opts.expectNoSpeech && opts.audioChecked && !isEffectivelySilent(v.heard))
  const reason = !samePerson ? `${opts.noPerson ? 'Different scene' : 'Different person'}: ${v.reason}`
    : !productMatches ? `Product changed: ${v.reason}`
    : !noGlitch ? `Visible glitch: ${v.reason}`
    : !lineMatches ? `Did not say the approved line (heard: "${v.heard}")`
    : !soundMatches ? `Sounds different from the first clip (voice or room): ${v.reason}`
    : !speechOk ? `Someone speaks in a shot that should be silent (heard: "${v.heard}")`
    : opts.noPerson ? 'Same scene and product.' : 'Same person, product and line.'
  return { passed: samePerson && lineMatches && productMatches && noGlitch && soundMatches && speechOk, samePerson, lineMatches, productMatches, speechOk, soundMatches, reason }
}

/** The TVC flow's narrow checks run only when the plan passes their inputs;
 *  talking-head and UGC calls never pass them and behave exactly as before. */
export function narrowWanted(i: { productMustBeVisible?: boolean; productScale?: string; expectExtras?: boolean; leadFileId?: string; action?: string }): boolean {
  return !!(i.productMustBeVisible || i.productScale || i.expectExtras || i.leadFileId || i.action)
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
    soundReferenceClipFileId: z.string().optional().describe("The ad's first spoken clip, when this is a later spoken clip: its voice and room sound (echo, background) must match, so the joined ad sounds like one recording"),
    expectNoSpeech: z.boolean().optional().describe('true for a shot that must be silent (no one speaks); the clip fails if words are heard'),
    noPerson: z.boolean().optional().describe('true when nobody is in the shot (product or scenery only); judges the scene instead of a presenter'),
    productMustBeVisible: z.boolean().optional().describe('TVC: the plan says the product is in this shot; the clip fails if it is missing in any sampled frame'),
    productScale: z.enum(['close', 'medium', 'wide']).optional().describe('TVC: how big the product is in the shot; wide judges only colour and label'),
    productExpectedState: z.string().optional().describe('TVC: a normal state of the product in this shot, e.g. "the bottle has no cap after the pop"'),
    expectExtras: z.boolean().optional().describe('TVC: this place needs background people; an empty background fails'),
    leadFileId: z.string().optional().describe('TVC: the lead actor\'s image; a background person who looks like the lead fails the clip'),
    action: z.string().optional().describe('TVC: the shot\'s action; the clip fails if it never happens'),
    endState: z.string().optional().describe('TVC: what must be true at the end, e.g. "the bottle has no cap"'),
    shotDurationSeconds: z.number().positive().optional().describe('TVC: the shot\'s planned length; returns trimStartSeconds centred on the action'),
  }),
  outputSchema: z.object({
    passed: z.boolean().optional(),
    samePerson: z.boolean().optional(),
    lineMatches: z.boolean().optional(),
    productMatches: z.boolean().optional(),
    glitch: z.boolean().optional(),
    soundMatches: z.boolean().optional(),
    mispronounced: z.array(z.string()).optional(),
    heard: z.string().optional(),
    reason: z.string().optional(),
    refused: z.boolean().optional(),
    refusalReason: z.string().optional(),
    productVisible: z.boolean().optional(),
    extrasPresent: z.boolean().optional(),
    leadClone: z.boolean().optional(),
    glitchFree: z.boolean().optional(),
    actionHappened: z.boolean().optional(),
    motionReversed: z.boolean().optional(),
    actionTime: z.number().nullable().optional(),
    endStateTrue: z.boolean().optional(),
    trimStartSeconds: z.number().optional(),
  }),
  execute: async (inputData, execContext) => {
    const { clipFileId, masterStillFileId, referenceFileIds, expectedLine: givenLine, productFileId, soundReferenceClipFileId, expectNoSpeech, noPerson, productMustBeVisible, productScale, productExpectedState, expectExtras, leadFileId, action, endState, shotDurationSeconds } = inputData as { clipFileId: string; masterStillFileId: string; referenceFileIds?: string[]; expectedLine?: string; productFileId?: string; soundReferenceClipFileId?: string; expectNoSpeech?: boolean; noPerson?: boolean; productMustBeVisible?: boolean; productScale?: string; productExpectedState?: string; expectExtras?: boolean; leadFileId?: string; action?: string; endState?: string; shotDurationSeconds?: number }
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE' }
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined ?? ''
    // A continued clip holds every line so far; check all of them, not just the new one.
    const lines = givenLine ? spokenSoFar(conversationId, clipFileId) : undefined
    const expectedLine = givenLine ? (lines?.join(' ') ?? givenLine) : undefined
    const narrow = narrowWanted({ productMustBeVisible, productScale, expectExtras, leadFileId, action })
    const dropped = await droppedCheckInputs(checkScopeOf(execContext?.requestContext), clipFileId, { expectedLine: !!expectedLine, product: !!productFileId, reference: !!referenceFileIds?.length, noSpeech: !!expectNoSpeech, presenter: !noPerson, productVisible: !!productMustBeVisible, extras: !!expectExtras, lead: !!leadFileId, action: !!action, endState: !!endState, productNarrow: !!(productFileId && (productScale || productMustBeVisible)), productExpectedState: !!productExpectedState })
    if (dropped.length) {
      return { refused: true, refusalReason: `CHECK_INPUTS_DROPPED: this clip was checked before with ${dropped.join(', ')}; check it again with the same inputs (never fewer) — a check without them proves nothing` }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), narrow ? NARROW_TIMEOUT_MS : TIMEOUT_MS)
    const workDir = mkdtempSync(join(tmpdir(), 'check-clip-'))
    try {
      const clip = await fetchBase64(clipFileId, idToken, controller.signal)
      // A still (a beat's image before it is animated) is checked as one frame,
      // with no audio.
      const isStill = clip.mime.startsWith('image/')
      const frames: Array<{ data: string; mime: string }> = []
      let audio: string | null = null
      let refAudio: string | null = null
      let clipPath: string | null = null
      let duration = 4
      if (isStill) frames.push({ data: clip.data, mime: clip.mime })
      else {
      clipPath = join(workDir, 'clip.mp4')
      writeFileSync(clipPath, Buffer.from(clip.data, 'base64'))
      const { stdout } = await execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clipPath], { timeout: 30_000 })
      duration = Number(stdout.trim()) || 4
      // Three frames: just after the start (Omni's glitches — a second bottle,
      // a hand swap — show in the first second), the middle, and near the end,
      // where drift shows up.
      for (const [i, t] of [Math.min(0.7, duration * 0.1), duration * 0.5, Math.max(0, duration - 0.3)].entries()) {
        const out = join(workDir, `f${i}.jpg`)
        await execFile('ffmpeg', ['-y', '-ss', String(t), '-i', clipPath, '-frames:v', '1', '-q:v', '3', out], { timeout: 30_000 })
        frames.push({ data: readFileSync(out).toString('base64'), mime: 'image/jpeg' })
      }
      if (expectedLine || soundReferenceClipFileId || expectNoSpeech) {
        const out = join(workDir, 'a.wav')
        await execFile('ffmpeg', ['-y', '-i', clipPath, '-vn', '-ac', '1', '-ar', '16000', out], { timeout: 30_000 })
        audio = readFileSync(out).toString('base64')
      }
      // A later clip's voice and room are compared with the first spoken clip:
      // 2026-10-05 one clip came back as a dry studio voice among gym-echo
      // clips, and no mixing at the join could hide it. Tested on that ad: the
      // studio clip failed 2/2, a matching clip and a same-clip control passed.
      if (soundReferenceClipFileId && soundReferenceClipFileId !== clipFileId) {
        const ref = await fetchBase64(soundReferenceClipFileId, idToken, controller.signal)
        const refPath = join(workDir, 'ref.mp4'), refOut = join(workDir, 'ref.wav')
        writeFileSync(refPath, Buffer.from(ref.data, 'base64'))
        await execFile('ffmpeg', ['-y', '-i', refPath, '-vn', '-ac', '1', '-ar', '16000', refOut], { timeout: 30_000 })
        refAudio = readFileSync(refOut).toString('base64')
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
      if (refAudio) {
        content.push({ type: 'text', text: 'Audio R (the first spoken clip of this ad):' })
        content.push({ type: 'input_audio', input_audio: { data: refAudio, format: 'wav' } })
      }
      if (audio) {
        content.push({ type: 'text', text: 'The clip\'s audio:' })
        content.push({ type: 'input_audio', input_audio: { data: audio, format: 'wav' } })
      }
      content.push({ type: 'text', text: buildCheckQuestion({ product: !!productFileId, audio: !!audio, noPerson: !!noPerson, silent: !!expectNoSpeech, sound: !!refAudio }) })

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
      const judged = judgeVerdict(verdict, { expectedLine, audioChecked: !!audio, expectNoSpeech: !!expectNoSpeech, noPerson: !!noPerson, soundChecked: !!refAudio })
      let narrowResult: NarrowClipResult | null = null
      if (narrow && clipPath) {
        try {
          const productImg = productFileId ? await fetchBase64(productFileId, idToken, controller.signal) : undefined
          const leadImg = leadFileId ? await fetchBase64(leadFileId, idToken, controller.signal) : undefined
          narrowResult = await runNarrowClipChecks(gatewayAsk(tenantId), (times) => sampleFrames(clipPath!, times, workDir), {
            duration, product: productImg, productScale: productScale as ProductScale | undefined, productExpectedState, productMustBeVisible,
            expectExtras, lead: leadImg, action, endState, shotDurationSeconds,
          })
        } catch (err) {
          // sampleFrames can throw a plain ffmpeg/execFile error, not just
          // CheckUnavailableError — either way the narrow check did not run,
          // so this clip is refused as unchecked, never a pass and never an
          // uncaught crash.
          const msg = err instanceof CheckUnavailableError ? err.message : `check unavailable: ${(err as Error)?.message ?? 'unknown'}`
          return { refused: true, refusalReason: `CHECK_UNAVAILABLE: ${msg} — this clip is unchecked; do not use it as checked` }
        }
      }
      // Only a clip that said the right line is checked word by word for how it was said.
      const misspoken = expectedLine && audio && judged.lineMatches ? await mispronouncedWords(audio, expectedLine, controller.signal) : null
      const saidClearly = !misspoken?.length
      const passed = judged.passed && saidClearly && (narrowResult ? narrowResult.passed : true)
      const reason = !judged.passed ? judged.reason
        : !saidClearly ? `A word is said wrongly: ${misspoken!.map(m => `"${m.meant}" sounds like "${m.heard}"`).join(', ')}`
        : narrowResult && !narrowResult.passed ? narrowResult.reasons.join(' ') : judged.reason
      if (!passed) {
        markCheckFailed(execContext?.requestContext, (execContext as unknown as { agent?: { messages?: unknown } })?.agent?.messages)
      }
      return {
        passed,
        ...(misspoken?.length ? { mispronounced: misspoken.map(m => `"${m.meant}" sounds like "${m.heard}"`) } : {}),
        samePerson: judged.samePerson, lineMatches: judged.lineMatches,
        productMatches: judged.productMatches, glitch: verdict.glitch, soundMatches: judged.soundMatches,
        heard: verdict.heard, reason,
        ...(narrowResult ? {
          glitchFree: narrowResult.glitchFree, productVisible: narrowResult.productVisible, extrasPresent: narrowResult.extrasPresent,
          leadClone: narrowResult.leadClone, actionHappened: narrowResult.actionHappened, motionReversed: narrowResult.motionReversed, actionTime: narrowResult.actionTime,
          endStateTrue: narrowResult.endStateTrue, trimStartSeconds: narrowResult.trimStartSeconds,
        } : {}),
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
