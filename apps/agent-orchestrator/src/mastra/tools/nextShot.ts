// The next shot, for every skill that makes several shots of one person: within one place and camera, a
// shot is an EDIT of that place's first approved photo, so the face, hair, room and camera stay identical;
// a new place or camera starts one fresh photo (from the person's sheet), which the shots after it edit.
// Proven 2026-10-16: the hand-made v12 and the edit-chain test held the same woman, hair, rug and camera
// across four fan-reel looks, where fresh drawings drifted every look.
import { sameSetting as sameSettingCore } from './sameSetting.js'
import type { AskFn, Img } from './tvcChecks.js'

export interface ShotChange {
  outfit?: string
  /** hair, jewellery, makeup; when set, the hair may change too */
  styling?: string
  /** copy the body pose from the second image (a reference frame) */
  poseFromFrame: boolean
  /** anything else, in plan words (e.g. "the TV remote is in her right hand") */
  extra?: string
}

const changes = (c: ShotChange): string[] => [
  ...(c.outfit ? [`the outfit to ${c.outfit}`] : []),
  ...(c.styling ? [`the styling (hair, jewellery, makeup) to ${c.styling}`] : []),
  ...(c.poseFromFrame ? [`the body pose: copy how the person's arms, hands, legs, head and body lie in the second image (a reference frame used only for the pose: not that person, outfit, objects or any text; nothing that covers or hides the person there is copied: the face and hair stay uncovered${c.outfit ? '' : ', and the outfit, including any dupatta or scarf, stays worn and draped as in the first image'})`] : []),
  ...(c.extra ? [c.extra] : []),
]

/** The change in short plain words, for checks that compare the photo before and after. */
export const changeSummary = (c: ShotChange): string => [...(c.outfit ? [`the outfit to ${c.outfit}`] : []), ...(c.styling ? [`the styling to ${c.styling}`] : []), ...(c.poseFromFrame ? ['the body pose'] : []), ...(c.extra ? [c.extra] : [])].join('; ')

export function editShotPrompt(c: ShotChange): string {
  const list = changes(c).map((x, i) => `(${i + 1}) ${x}`).join('; ')
  // No "exactly as in the first image" and no "size and position": that pinned the body and the pose never
  // changed (fan run real13 A/B); the camera is kept by naming its framing.
  const keep = ['the same person and face', ...(c.styling ? [] : ['the hair']), ...(c.outfit ? [] : ['the outfit']), 'the room, floor, furniture and light', 'the camera height, angle and framing']
  return `Edit the first image. Change only: ${list}. Keep ${keep.join(', ')}. Real photo, no text.`
}

/** The prompt check's plan line for an edited shot: what changes, in plan refs, and that the rest is kept. */
export function editShotGateLine(c: ShotChange, ref: string): string {
  const what = [...(c.outfit ? [`${ref} outfit to ${c.outfit}`] : []), ...(c.styling ? [`${ref} styling to ${c.styling}`] : []), ...(c.poseFromFrame ? ['the pose of the person in the second image (a reference frame, not described in words)'] : []), ...(c.extra ? [c.extra] : [])]
  return `edit of the previous approved photo (the first image), which already has the right person, room and camera; it changes only: ${what.join('; ')}; everything else kept from the first image`
}

/** Which frames of the original show the same place and camera: each frame joins the first earlier group
 *  whose first frame is the same place, else starts a new group. An unknown answer starts a new group (a
 *  fresh photo is always safe; a wrong edit would copy the wrong room). */
export async function placeGroups(ask: AskFn, frames: Img[], same: typeof sameSettingCore = sameSettingCore): Promise<number[]> {
  const firsts: Img[] = []
  const out: number[] = []
  for (const f of frames) {
    let g = -1
    for (let i = 0; i < firsts.length && g < 0; i++) if ((await same(ask, firsts[i], f)).same === true) g = i
    if (g < 0) { firsts.push(f); g = firsts.length - 1 }
    out.push(g)
  }
  return out
}
