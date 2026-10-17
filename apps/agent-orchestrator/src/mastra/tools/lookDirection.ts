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
  `moves: what she does during the look, in order, slow and natural ("" when she holds still). ` +
  `objects: where each of these objects is during the look: ${objects.length ? objects.join(', ') : 'none'} (for example "the black remote lies on the rug beside her left hand"; "" if none). ` +
  `Reply ONLY JSON {"start":"","moves":"","objects":""}`

export async function lookDirection(ask: AskFn, frames: Img[], objects: string[]): Promise<LookDirection | null> {
  try {
    const v = await ask([...frames.flatMap((image, i) => [{ text: `Frame ${i + 1}:` }, { image }]), { text: LOOK_DIRECTION_QUESTION(objects) }])
    const start = typeof v.start === 'string' ? v.start.trim() : ''
    if (!start) return null
    return { start, moves: typeof v.moves === 'string' ? v.moves.trim() : '', objects: typeof v.objects === 'string' ? v.objects.trim() : '' }
  } catch {
    return null
  }
}
