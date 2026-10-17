// A photographer's direction for one look of a reel, read from the original's own frames: her starting pose (hands,
// arms, legs, head, attitude), what she does during the look, and where the objects rest. The remake's photos and
// clips are directed with it, as v12's were by hand ("one hand resting on her chest, one knee bent over the other
// leg"; "the remote stays still on the rug"). Without it she lay there "acceptable, not exceptional" and kept the
// remote in her hand (fan run real27, 2026-10-17). Shared by any skill that recreates a person's look. No answer or
// no starting pose is null, never a made-up direction.
import type { AskFn, Img } from './tvcChecks.js'

export interface LookDirection { start: string; moves: string; objects: string }

export const LOOK_DIRECTION_QUESTION = (objects: string[]): string =>
  `These frames are one look of a fashion reel, in time order. Write how a photographer would direct the model to recreate this look, in short plain words, with sides as seen in the image (image-left / image-right). ` +
  `start: her pose when the look is first seen: arms and hands, legs, head and attitude (one sentence). ` +
  `moves: what she does during the look, in order, with rough times from the start of the look ("at about 1s"), slow and natural; include every gesture with a prop and every change of leg side ("" when she holds still). ` +
  `objects: where each of these objects is during the look: ${objects.length ? objects.join(', ') : 'none'} (for example "the black remote lies on the rug beside her left hand"; "" if none). ` +
  `Reply ONLY JSON {"start":"","moves":"","objects":""}`

/** times: each frame's time from the start of the look (three frames missed the remote pointed up and the legs'
 *  swing, fan run real30: give it the look every half second). */
export async function lookDirection(ask: AskFn, frames: Img[], objects: string[], times?: number[]): Promise<LookDirection | null> {
  try {
    const label = (i: number) => (times?.[i] !== undefined ? `Frame at ${times[i].toFixed(1)}s:` : `Frame ${i + 1}:`)
    const v = await ask([...frames.flatMap((image, i) => [{ text: label(i) }, { image }]), { text: LOOK_DIRECTION_QUESTION(objects) }])
    const start = typeof v.start === 'string' ? v.start.trim() : ''
    if (!start) return null
    return { start, moves: typeof v.moves === 'string' ? v.moves.trim() : '', objects: typeof v.objects === 'string' ? v.objects.trim() : '' }
  } catch {
    return null
  }
}

/** Does a made photo follow its direction (her pose, where the objects rest)? Look 3 kept the remote in her hand
 *  and look 4's legs were not crossed (fan run real28). No answer is unknown, never a pass. */
export async function followsDirection(ask: AskFn, photo: Img, d: LookDirection): Promise<{ status: 'pass' | 'fail' | 'unknown'; reason: string }> {
  try {
    const v = await ask([{ image: photo }, { text: `A model was directed to pose like this: ${d.start}.${d.objects ? ` Objects: ${d.objects}.` : ''} Sides are as seen in the image. Judge the photo: does her pose broadly follow it (arms, hands, legs; small differences are fine), and are the objects where the direction says? Reply ONLY JSON {"pose_matches":true|false,"objects_match":true|false,"differs":"short, what is different"}` }])
    if (v.pose_matches === true && (v.objects_match === true || !d.objects)) return { status: 'pass', reason: 'as directed' }
    if (v.pose_matches === false || v.objects_match === false) return { status: 'fail', reason: `not as directed: ${String(v.differs ?? '').replace(/\.+$/, '') || 'the pose or the objects differ'}` }
  } catch { /* unknown */ }
  return { status: 'unknown', reason: 'the photo could not be compared with its direction' }
}
