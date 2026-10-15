import { createScorer } from '@mastra/core/evals'
import { askChecked, gatewayAsk, CheckUnavailableError, type AskFn, type AskPart, type Img } from '../../tools/tvcChecks.js'
import { checkModel } from '../../tools/videoBreakdown/models.js'

type Status = 'pass' | 'fail' | 'unknown'
type Verdict = { status: Status; reason: string } & Record<string, unknown>
export type VisionInput = { ask?: AskFn; tenantId?: string }
const askFor = (input: VisionInput): AskFn => input.ask ?? gatewayAsk(input.tenantId ?? '', fetch, checkModel())
const NO_FRAMES: Verdict = { status: 'unknown', reason: 'no frames to check' }
const imgs = (label: string, frames: Img[]): AskPart[] => frames.flatMap((f, i) => [{ text: `${label} ${i + 1}:` }, { image: f }])

// Function-based analyze steps: Mastra prompt-object judges are text-only, ours need images.
function videoScorer<I extends VisionInput>(id: string, description: string, analyze: (input: I) => Promise<Verdict>) {
  return createScorer({ id, name: id, description })
    .analyze(async ({ run }) => {
      try { return await analyze(run.input as I) } catch (err) {
        if (err instanceof CheckUnavailableError) return { status: 'unknown' as Status, reason: err.message }
        throw err
      }
    })
    .generateScore(({ results }) => ((results.analyzeStepResult as Verdict).status === 'pass' ? 1 : 0))
    .generateReason(({ results }) => (results.analyzeStepResult as Verdict).reason)
}

export const propCountScorer = videoScorer('video-prop-count', 'Exactly the expected number of a prop in every frame', async (input: VisionInput & { frames: Img[]; prop: string; expected: number }) => {
  if (!input.frames.length) return NO_FRAMES
  const v = await askChecked(askFor(input), [...imgs('Frame', input.frames), { text: `For EACH frame in order, count how many ${input.prop} are visible (in hands or anywhere). Reply ONLY JSON {"counts":[n per frame]}` }], [{ key: 'counts', type: 'array' }])
  const counts = (v.counts as unknown[]).map(Number)
  if (counts.length !== input.frames.length || counts.some((c) => !Number.isFinite(c))) return { status: 'unknown', reason: 'checker skipped frames', counts }
  const bad = counts.map((c, i) => [c, i] as const).filter(([c]) => c !== input.expected)
  return bad.length ? { status: 'fail', reason: `${input.prop}: ${bad.map(([c, i]) => `${c} in frame ${i + 1}`).join(', ')} (expected ${input.expected})`, counts } : { status: 'pass', reason: `${input.expected} ${input.prop} in every frame`, counts }
})

export const samePersonScorer = videoScorer('video-same-person', 'Every frame shows the same person as the reference (8/10 or more)', async (input: VisionInput & { reference: Img; frames: Img[] }) => {
  if (!input.frames.length) return NO_FRAMES
  const v = await askChecked(askFor(input), [{ text: 'IDENTITY REFERENCE:' }, { image: input.reference }, ...imgs('Candidate', input.frames), { text: 'Judge ONLY the face (bone structure, face shape, nose, eyes, brows, lips, jaw; ignore hair, makeup, outfit, pose, angle). For each candidate give a same-person score 1-10. Reply ONLY JSON {"scores":[n per candidate],"differences":"short"}' }], [{ key: 'scores', type: 'array' }])
  const scores = (v.scores as unknown[]).map(Number)
  if (scores.length !== input.frames.length || scores.some((s) => !Number.isFinite(s))) return { status: 'unknown', reason: 'checker skipped candidates', scores }
  return scores.every((s) => s >= 8) ? { status: 'pass', reason: `scores ${scores.join(', ')}`, scores } : { status: 'fail', reason: `scores ${scores.join(', ')}: ${String(v.differences ?? '')}`, scores }
})

export const expressionScorer = videoScorer('video-expression', 'Same mouth, eyes and mood as the reference at the same moment', async (input: VisionInput & { reference: Img; frame: Img; expected: string }) => {
  const v = await askChecked(askFor(input), [{ text: 'REFERENCE face:' }, { image: input.reference }, { text: 'REMAKE face:' }, { image: input.frame }, { text: `Expected expression: ${input.expected}. Compare the REMAKE to the REFERENCE. Reply ONLY JSON {"same_mouth":true|false,"same_eyes":true|false,"same_mood":true|false,"what":"short"}` }], [{ key: 'same_mouth', type: 'boolean' }, { key: 'same_eyes', type: 'boolean' }, { key: 'same_mood', type: 'boolean' }])
  const ok = v.same_mouth === true && v.same_eyes === true && v.same_mood === true
  return { status: ok ? 'pass' : 'fail', reason: String(v.what ?? '') }
})

export const poseLegsScorer = videoScorer('video-pose-legs', 'Same pose and body axis as the reference; feet on the expected side', async (input: VisionInput & { reference: Img; frame: Img; expectedFeet: 'image-left' | 'image-right' | 'center' }) => {
  const v = await askChecked(askFor(input), [{ text: 'REFERENCE:' }, { image: input.reference }, { text: 'REMAKE:' }, { image: input.frame }, { text: 'Two photos of a person. Use IMAGE directions (viewer left/right). For the REMAKE: where do the FEET end up relative to the hips, and where do the KNEES point? Is the overall pose (arms, legs, head) the same as the REFERENCE? Is the body axis (straight vs diagonal, centred vs off-centre) the same? Reply ONLY JSON {"feet":"image-left|image-right|center","knees":"image-left|image-right|center","same_pose":true|false,"body_axis_same":true|false,"what":"short"}' }], [{ key: 'feet', type: 'string' }, { key: 'knees', type: 'string' }, { key: 'same_pose', type: 'boolean' }, { key: 'body_axis_same', type: 'boolean' }])
  const ok = v.feet === input.expectedFeet && v.same_pose === true && v.body_axis_same === true
  return { status: ok ? 'pass' : 'fail', reason: `feet ${String(v.feet)}, knees ${String(v.knees)}, pose ${v.same_pose ? 'same' : 'different'}, axis ${v.body_axis_same ? 'same' : 'different'}${v.what ? ` — ${String(v.what)}` : ''}`, feet: v.feet, knees: v.knees }
})

export const emptyHandScorer = videoScorer('video-empty-hand', 'No hand acts on an object that is not there', async (input: VisionInput & { frames: Img[] }) => {
  if (!input.frames.length) return NO_FRAMES
  const v = await askChecked(askFor(input), [...imgs('Frame (time order)', input.frames), { text: 'Does any hand grab, touch, adjust or hold something that is NOT actually there (pinching air, adjusting a missing dupatta)? Reply ONLY JSON {"empty_hand_action":true|false,"what":"short"}' }], [{ key: 'empty_hand_action', type: 'boolean' }])
  return v.empty_hand_action === false ? { status: 'pass', reason: 'no empty-hand action' } : { status: 'fail', reason: String(v.what ?? 'hand acts on nothing') }
})
