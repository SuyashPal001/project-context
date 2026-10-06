import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { askClarifyingQuestionsTool } from './askClarifyingQuestions.js'
import { clipCheckFailure, markShotReviewed, type ShotKind } from './reviewGate.js'

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

type Answer = { selectedLabel?: string; selectedLabels?: string[]; freeText?: string; skipped?: boolean }

/** The user's answer to the review question, as a decision. Exported for tests. */
export function reviewOutcome(kind: ShotKind, shots: Array<{ fileId: string; label: string }>, answer: Answer | undefined): ReviewOutcome {
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
    return { decision: 'continue', fix: [], nextStep: kind === 'still' ? 'Continue: make the remaining stills, or if every still exists, the clips.' : 'Continue: make the remaining clips, or if every clip exists, finish the ad.' }
  }
  const names = fix.map((f) => `${f.label} (${f.fileId})`).join(', ')
  const how = kind === 'still'
    ? `Delegate to agent-director: fix ONLY ${names} with edit_image on that still${note ? ` — the change: "${note}"` : ''}; keep everything else exactly as it is. Never generate_image a fresh one and never touch the other scenes.`
    : `Delegate to agent-director: remake ONLY ${names} with generate_video from that scene's approved still${note ? ` — the change: "${note}"` : ''}. Do not touch the other clips.`
  return { decision: 'fix', fix, note, nextStep: `${how} Then call review_shots again with just the fixed ${kind}${fix.length > 1 ? 's' : ''}.` }
}

export const reviewShotsTool = createTool({
  id: 'review_shots',
  description:
    'Show the user an ad\'s stills or clips and ask whether they look right — the ONLY way to review them in an ad flow (never ask_clarifying_questions for this). ' +
    'Call it with the first scene\'s still (or clip) alone as soon as Director returns it, before any more are made, and again with the rest once they exist. ' +
    'One shot: asks "does this look right?". Several: the user picks the scenes that need a fix. Returns decision, the scenes to fix, the user\'s note and the exact next step. Free.',
  inputSchema: z.object({
    kind: z.enum(['still', 'clip']).describe('"still" for pictures, "clip" for videos'),
    shots: z.array(shotSchema).min(1).max(8).describe('In scene order'),
    question: z.string().max(200).optional().describe('Optional wording for the question; a plain default is used without it'),
  }),
  execute: async (inputData, execContext) => {
    const given = inputData as { kind: ShotKind; shots: Array<{ fileId: string; label: string }>; question?: string }
    const { kind, question } = given
    const shots = given.shots.map((s) => ({ ...s, label: s.label.trim().slice(0, 40) }))
    const noun = kind === 'still' ? 'picture' : 'clip'
    const failed = kind === 'clip' ? shots.map((s) => clipCheckFailure(s.fileId)) : shots.map(() => undefined)
    const anyFailed = failed.some(Boolean)
    const q = shots.length === 1
      ? {
          prompt: question ?? `Does ${shots[0].label} look right? The other scenes are built from this ${noun}, so anything off here would carry into them.`,
          options: anyFailed
            ? [{ label: FIX_IT_RECOMMENDED, rationale: `The check found: ${failed[0]}` }, { label: LOOKS_GOOD_PLAIN }]
            : [{ label: LOOKS_GOOD }, { label: FIX_IT, rationale: 'Say what to change below' }],
          allowFreeText: true, allowSkip: true,
        }
      : {
          prompt: question ?? `Here are the ${shots.length} scenes. Tap any that need a fix and say what below, or continue.`,
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
    const outcome = reviewOutcome(kind, shots, asked.answers?.[0])
    if (outcome.decision === 'continue') {
      markShotReviewed(execContext?.requestContext?.get('conversationId') as string | undefined, kind)
    }
    return outcome
  },
})
