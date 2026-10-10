import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { askClarifyingQuestionsTool } from './askClarifyingQuestions.js'
import { briefRefsFor, clipCheckFailure, isTvcAd, markShotReviewed, notMadeHere, type ShotKind } from './reviewGate.js'
import { checkClip } from './checkClip.js'
import { MAX_SHOTS_30 } from './tvcPlan.js'

// The one way an ad's stills and clips are put to the user, built here rather
// than written freely each time. 2026-10-06 (Lakmē ad): the free-form review
// offered "Regenerate stills with changes" — all three — when only scene 3 had
// a fault, put the stills on the answer buttons ("Approve" showed scene 1), and
// asked, showed files, then asked again. Here the first shot gets a plain
// "does this look right?"; a set gets one pick per scene, so only the scenes
// the user names are fixed, and a still is fixed by an edit, never remade.

const LOOKS_GOOD = 'Looks good — continue (Recommended)'
const FIX_IT = 'Fix it'
const ALL_GOOD = 'All good — continue (Recommended)'
// When the check already failed a clip, continuing is not the safe pick.
const LOOKS_GOOD_PLAIN = 'Looks good — continue'
const FIX_IT_RECOMMENDED = 'Fix it (Recommended)'
const ALL_GOOD_PLAIN = 'All good — continue'
const wantsContinue = (picked: string[]) => picked.some((l) => l === LOOKS_GOOD || l === LOOKS_GOOD_PLAIN || l === ALL_GOOD || l === ALL_GOOD_PLAIN)
const wantsFix = (picked: string[]) => picked.some((l) => l === FIX_IT || l === FIX_IT_RECOMMENDED)

const shotSchema = z.object({
  fileId: z.string().uuid().describe('The still or clip the user is looking at'),
  // No max: a long label once failed the whole call (Lakmē, 2026-10-06); it is cut to fit instead.
  label: z.string().min(1).describe('Short, how the user knows it: "Scene 1", "Scene 2 — the reveal"'),
})

export interface ReviewOutcome {
  decision: 'continue' | 'fix' | 'skipped'
  fix: Array<{ fileId: string; label: string }>
  note?: string
  nextStep: string
}

/** "Scene 2 — Product Benefit Still" -> "Scene 2 — Product Benefit": the card already says what it shows, and the extra word wrapped the label. */
export function shotLabel(label: string): string {
  return label.trim().replace(/[\s—–-]*\b(still|clip|video clip|image|picture)$/i, '').trim().slice(0, 40) || label.trim().slice(0, 40)
}

// Always on the card, under any wording Olmo gives: a tapped picture means
// "fix this one", which a bare "Do these look good?" never said (2026-10-06).
const PICK_HINT = 'Tap any scene that needs a fix and say what below, or continue.'

type StillCheck = { productMatches?: boolean; glitch?: boolean; reason?: string; refused?: boolean }

/** Checks each still against the brief's product photo (and avatar) before the user sees it.
 *  Only a wrong product or a broken picture counts: a hands-only close-up is not "a different person". */
async function stillFaults(shots: Array<{ fileId: string }>, productFileId: string | undefined, avatarFileId: string | undefined, execContext: unknown): Promise<Array<string | undefined>> {
  if (!productFileId) return shots.map(() => undefined)
  const ctx = { requestContext: (execContext as { requestContext?: unknown })?.requestContext }
  const run = (checkClip as unknown as { execute: (i: unknown, c: unknown) => Promise<StillCheck> }).execute
  return Promise.all(shots.map(async (s) => {
    try {
      const r = await run({ clipFileId: s.fileId, masterStillFileId: shots[0].fileId, productFileId, ...(avatarFileId ? { referenceFileIds: [avatarFileId] } : {}) }, ctx)
      if (r.refused) return undefined
      if (r.productMatches === false) return `wrong product — ${r.reason ?? 'it does not match the product photo'}`
      if (r.glitch) return `looks broken — ${r.reason ?? 'a glitch in the picture'}`
      return undefined
    } catch { return undefined }
  }))
}

type Answer = { selectedLabel?: string; selectedLabels?: string[]; freeText?: string; skipped?: boolean }

/** The user's answer to the review question, as a decision. Exported for tests. */
export function reviewOutcome(kind: ShotKind, shots: Array<{ fileId: string; label: string }>, answer: Answer | undefined, opts: { tvcAsk?: boolean } = {}): ReviewOutcome {
  const note = answer?.freeText?.trim() || undefined
  const picked = answer?.selectedLabels ?? (answer?.selectedLabel ? [answer.selectedLabel] : [])
  if (!answer || (answer.skipped && !note)) {
    return { decision: 'skipped', fix: [], nextStep: 'The user skipped the review. Ask in one short sentence whether to continue; make nothing new until they answer.' }
  }
  let fix: Array<{ fileId: string; label: string }>
  if (shots.length === 1) {
    fix = wantsFix(picked) || (!!note && !wantsContinue(picked)) ? shots : []
  } else {
    fix = shots.filter((s) => picked.includes(s.label))
    // Only a note, no scene picked: the note says which; Olmo reads it.
    if (fix.length === 0 && note && !wantsContinue(picked)) {
      return {
        decision: 'fix', fix: [], note,
        nextStep: `The user wrote what to change but picked no scene. Work out from the note which ${kind}s it means; if it is unclear, ask which scene in one short question. Then fix only those.`,
      }
    }
  }
  if (fix.length === 0) {
    return {
      decision: 'continue', fix: [],
      nextStep: kind === 'still'
        ? (opts.tvcAsk ? 'Continue: make the remaining stills, or if every still exists, the rough cut: delegate "step: animatic" to agent-director.' : 'Continue: make the remaining stills, or if every still exists, the clips.')
        : kind === 'voice' ? 'Continue: delegate to agent-director to make the rest of the narration as ONE generate_narration call — every remaining line in one script, same voiceId and direction — then lay the first line and that one take with mix_voiceover and finish the ad.'
        : 'Continue: make the remaining clips, or if every clip exists, finish the ad.',
    }
  }
  const names = fix.map((f) => `${f.label} (${f.fileId})`).join(', ')
  const how = kind === 'voice'
    ? `Delegate to agent-director: remake ONLY the first narration line with generate_narration${note ? ` — the change: "${note}"` : ''}; keep the script unless the note changes it.`
    : kind === 'still'
    ? `Delegate to agent-director: fix ONLY ${names} with edit_image on that still${note ? ` — the change: "${note}"` : ''}; keep everything else exactly as it is. Never generate_image a fresh one and never touch the other scenes.`
    : `Delegate to agent-director: remake ONLY ${names} with generate_video from that scene's approved still${note ? ` — the change: "${note}"` : ''}. Do not touch the other clips.`
  return { decision: 'fix', fix, note, nextStep: `${how} Then call review_shots again with just the fixed ${kind}${fix.length > 1 ? 's' : ''}.` }
}

export const inputSchema = z.object({
  kind: z.enum(['still', 'clip', 'voice']).describe('"still" for pictures, "clip" for videos, "voice" for the first narration line'),
  // MAX_SHOTS_30 (20): a 30s TVC ad can plan up to 20 shots (tvcPlan.ts), and
  // Ask mode reviews all of them in one call once the first scene is approved.
  shots: z.array(shotSchema).min(1).max(MAX_SHOTS_30).describe('In scene order'),
  question: z.string().max(200).optional().describe('Optional wording for the question; a plain default is used without it'),
  productFileId: z.string().optional().describe('The product photo, when the ad has one; stills are checked against it before the user sees them. Taken from the brief when left out.'),
})

export const reviewShotsTool = createTool({
  id: 'review_shots',
  description:
    'Show the user an ad\'s stills, clips or first narration line (kind "voice") and ask whether they look right — the ONLY way to review them in an ad flow (never ask_clarifying_questions for this). ' +
    'Call it with the first scene\'s still (or clip) alone as soon as Director returns it, before any more are made, and again with the rest once they exist. ' +
    'One shot: asks "does this look right?". Several: the user picks the scenes that need a fix. Returns decision, the scenes to fix, the user\'s note and the exact next step. Free.',
  inputSchema,
  execute: async (inputData, execContext) => {
    const given = inputData as { kind: ShotKind; shots: Array<{ fileId: string; label: string }>; question?: string; productFileId?: string }
    const { kind, question } = given
    const shots = given.shots.map((s) => ({ ...s, label: shotLabel(s.label) }))
    const noun = kind === 'still' ? 'picture' : kind === 'voice' ? 'voice' : 'clip'
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const missing = notMadeHere(conversationId, shots.map((s) => s.fileId))
    if (missing.length) {
      return {
        decision: 'skipped' as const, fix: [],
        nextStep: `NOT_MADE: ${missing.join(', ')} was never generated in this chat (the Director came back with nothing). Do not ask the user about it. Delegate the ${noun} to agent-director again, then call review_shots with the file it returns.`,
      }
    }
    // Stills are checked here, so a wrong product (scene 1 held a pink tube,
    // not the Lakmē bullet, 2026-10-06) is flagged before it is animated.
    const brief = briefRefsFor(conversationId)
    const failed = kind === 'voice' ? shots.map(() => undefined)
      : kind === 'clip'
      ? shots.map((s) => clipCheckFailure(s.fileId))
      : await stillFaults(shots, given.productFileId ?? brief.productFileId, brief.avatarFileId, execContext)
    const anyFailed = failed.some(Boolean)
    const q = shots.length === 1
      ? {
          prompt: kind === 'voice'
            ? `${question ?? 'Does this voice sound right?'} The rest of the narration is read in this voice.`
            : `${question ?? `Does ${shots[0].label} look right?`} The other scenes are built from this ${noun}, so anything off here would carry into them.`,
          options: anyFailed
            ? [{ label: FIX_IT_RECOMMENDED, rationale: `The check found: ${failed[0]}` }, { label: LOOKS_GOOD_PLAIN }]
            : [{ label: LOOKS_GOOD }, { label: FIX_IT, rationale: 'Say what to change below' }],
          allowFreeText: true, allowSkip: true,
        }
      : {
          prompt: `${question ?? `Here are the ${shots.length} scenes.`} ${PICK_HINT}`,
          options: [
            ...shots.map((s, i) => ({
              label: s.label,
              ...(kind === 'still' ? { imageFileId: s.fileId } : {}),
              ...(failed[i] ? { rationale: `Needs a fix (Recommended): ${failed[i]}` } : {}),
            })),
            { label: anyFailed ? ALL_GOOD_PLAIN : ALL_GOOD },
          ],
          allowFreeText: true, allowSkip: true,
          multiSelect: { min: 1, max: shots.length + 1 },
        }
    const asked = await (askClarifyingQuestionsTool as unknown as { execute: (input: unknown, ctx: unknown) => Promise<{ answers?: Answer[]; error?: string }> })
      .execute({ questions: [q] }, execContext)
    if (asked.error) return { decision: 'skipped', fix: [], nextStep: `Could not ask (${asked.error}). Ask the user in one plain sentence whether the ${noun}s look right.` }
    const outcome = reviewOutcome(kind, shots, asked.answers?.[0], { tvcAsk: isTvcAd(conversationId) && execContext?.requestContext?.get('allowMode') !== 'auto' })
    if (outcome.decision === 'continue') {
      markShotReviewed(conversationId, kind)
    }
    return outcome
  },
})
