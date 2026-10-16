// Stills from a photo board (user's pick after the metro + fan A/B, 2026-10-16): the stills of one outfit
// look are made as ONE image of 2-3 photos side by side, so the person, light and colour hold across
// them and fewer images are paid for. Each photo is cut out free and goes through the same checks and
// one edit retry as a single still. The prompt is built from the same still words, never written freehand.
// Never the word "storyboard": it drew a cartoon in the A/B.
import { refOf } from './looks.js'
import { CAST_BY_IMAGE, stillBits, stillGateInput, type CharacterImages } from './prompts.js'
import type { RemakeLook, RemakePlan } from './types.js'

/** Charge slot of board i (stills use n*4+…, clips 1000+). */
export const BOARD_SLOT = 500
const MAX_PHOTOS = 3

/** n stills split into boards of 2-3, as even as possible; one still is never left alone. */
export function boardChunks(n: number): number[] {
  const k = Math.ceil(n / MAX_PHOTOS)
  return Array.from({ length: k }, (_, i) => Math.floor(n / k) + (i < n % k ? 1 : 0))
}

/** The board's shape for 2 or 3 vertical photos side by side (the image model's shapes). */
export const boardAspect = (n: number): '1:1' | '16:9' => (n <= 2 ? '1:1' : '16:9')

/** Stills grouped into units: a board (2-3 stills of the same outfit look) or a single still. Boards only
 *  for vertical reels with a person and no product photo (the product needs its own reference slot). */
export function boardUnits<T extends { look: RemakeLook; person: boolean }>(jobs: T[], o: { aspectRatio: string; product: boolean }): T[][] {
  if (o.aspectRatio !== '9:16' || o.product) return jobs.map((j) => [j])
  const units: T[][] = []
  const groups = new Map<number, T[]>()
  for (const j of jobs) {
    if (!j.person) { units.push([j]); continue }
    const k = refOf(j.look)
    if (!groups.has(k)) { groups.set(k, []); units.push(groups.get(k)!) }
    groups.get(k)!.push(j)
  }
  return units.flatMap((u) => {
    if (u.length < 2) return [u]
    let at = 0
    return boardChunks(u.length).map((size) => u.slice(at, (at += size)))
  })
}

type Photo = { look: RemakeLook; kind: 'start' | 'end' }

export function boardPrompt(plan: RemakePlan, photos: Photo[], characters?: CharacterImages): string {
  const bits = photos.map((p) => stillBits(plan, p.look, p.kind, characters))
  const n = photos.length
  const trick = [...new Set(bits.flatMap((b) => b.trick))]
  return [
    `${n} real photographs side by side in one image, each a vertical 9:16 phone photo, separated by plain white gaps, in time order left to right; no numbers, captions or text.`,
    'Every photo is a real candid photo from the same phone camera, with the same light and colour.',
    'The person in every photo is the person in the first image: same face, hair and body.',
    bits[0].settingKept
      ? `The second image shows ${n} reference frames in the same order; each photo copies ONLY the body pose, camera framing, setting and where objects sit from its frame; not its person, face, outfit, accessories or any text.`
      : `The second image shows ${n} reference frames in the same order; each photo copies ONLY the body pose, camera framing and where objects sit from its frame; not its person, face, outfit, accessories, setting or any text.`,
    bits[0].setting,
    ...bits.map((b, i) => [`Photo ${i + 1}:`, ...b.person, ...(b.props.length ? [`Objects: ${b.props.join('; ')}.`] : [])].join(' ')),
    ...(trick.length ? [`Do not draw: ${trick.join('; ')}.`] : []),
    'Add nothing that is not described here: no extra people, effects, text or logos.',
  ].filter(Boolean).join(' ')
}

/** One prompt check for the board: every photo's plan lines and words, the person by image. Objects in
 *  only some photos are listed per photo (one shared list read photo 2's earbuds as missing from photo 1),
 *  and each photo names its outfit look (look 3 can be part 2 of looks[1]). */
export function boardGateInput(plan: RemakePlan, photos: Photo[], prompt: string, characters?: CharacterImages) {
  const each = photos.map((p) => stillGateInput(plan, p.look, p.kind, prompt, characters))
  const lines = [...new Set(each.flatMap((g) => g.planLine.split('; ').slice(1).filter((l) => l !== CAST_BY_IMAGE)))]
  const shared = each[0].startFrameObjects.filter((o) => each.every((g) => g.startFrameObjects.includes(o)))
  return {
    prompt,
    planLine: [`one image of ${photos.length} photos side by side: ${photos.map((p) => `look ${p.look.n} ${p.kind} still (looks[${refOf(p.look)}])`).join(', ')}`, CAST_BY_IMAGE, ...lines].join('; '),
    look: { photos: each.map((g, i) => ({ photo: i + 1, ...g.look, objects: g.startFrameObjects })) } as Record<string, unknown> & { expression?: string },
    startFrameObjects: shared,
    keyMoments: [] as string[],
  }
}
