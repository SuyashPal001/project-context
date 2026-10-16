// The remake's own split of the still checks (user's call, 2026-10-16): a HARD fault gets one paid
// retry; a WARNING keeps the still and shows the user what may be off. Made-up text on signs is a
// warning ("not always that bad"). The face is hard, judged against the chosen person's reference
// sheet (front, 3/4, profile, full body), not a small front crop. The TVC checks are unchanged.
import { askChecked, checkLeadClone, checkLeadFace, GLITCH_QUESTION, type AskFn, type Img } from '../tools/tvcChecks.js'

const HARD_GLITCHES = ['duplicate_object', 'stray_face', 'cg_effect', 'flat_background', 'drawn'] as const
const WARN_GLITCHES = ['invented_text'] as const
const SAY: Record<string, string> = { duplicate_object: 'an object appears twice', stray_face: 'a face where none belongs', cg_effect: 'a cartoon or CG effect', flat_background: 'a flat graphic background', invented_text: 'made-up text on a sign or object', drawn: 'not a real photo' }
// The TVC question plus one remake question: a whole still drawn as a cartoon or illustration passed
// every check (metro A/B, storyboard panels); cg_effect only asks about effects inside a photo.
const REMAKE_GLITCH_QUESTION = GLITCH_QUESTION.replace(' Reply ONLY JSON {', ', drawn (the whole image is a drawing, illustration, cartoon, painting or 3D render, not a real photograph). Reply ONLY JSON {"drawn":true|false,')
// The original shows the person from the back, so the still may show no face at all; a face or hair
// that IS in view must still be the chosen person (metro A/B: the original man's face passed in profile).
export const VISIBLE_FACE_QUESTION = 'Image L is the lead actor. Image F is a still from the ad. Is any part of the person\'s face or hair visible in Image F (profile and side views count; the back of a head shows hair)? If so, is it CLEARLY a different person from Image L, judged by face and hair only? If you cannot tell (too little shows), answer false. Reply ONLY JSON {"face_visible":true|false,"clearly_different":true|false,"why":"short"}'

/** The picked person could pass for under 18 (video of them would be blocked). A failed check never
 *  blocks the pick: the clip step still refuses in plain words if the video model does. */
export async function looksUnder18(ask: AskFn, person: Img): Promise<boolean> {
  try {
    const v = await ask([{ image: person }, { text: 'Could the person in this image pass for under 18 to a careful viewer (face, build, styling)? Reply ONLY JSON {"could_be_under_18":true|false}' }])
    return v.could_be_under_18 === true
  } catch (err) {
    console.error('[remake] age check failed:', err instanceof Error ? err.message : String(err))
    return false
  }
}

export interface StillVerdict { passed: boolean; reasons: string[]; warnings: string[] }

export async function remakeStillChecks(ask: AskFn, still: Img, opts: { lead?: Img; leadInShot?: boolean; faceMayHide?: boolean }): Promise<StillVerdict> {
  const [g, face, clone, visible] = await Promise.all([
    askChecked(ask, [{ image: still }, { text: REMAKE_GLITCH_QUESTION }], [...HARD_GLITCHES, ...WARN_GLITCHES].map((key) => ({ key, type: 'boolean' as const }))),
    opts.lead && opts.leadInShot ? checkLeadFace(ask, opts.lead, still) : null,
    opts.lead ? checkLeadClone(ask, opts.lead, [still]) : null,
    opts.lead && opts.faceMayHide ? ask([{ text: 'Image L:' }, { image: opts.lead }, { text: 'Image F:' }, { image: still }, { text: VISIBLE_FACE_QUESTION }]) : null,
  ])
  const what = g.what ? ` (${String(g.what)})` : ''
  const reasons = HARD_GLITCHES.filter((k) => g[k] === true).map((k) => `${SAY[k]}${what}`)
  const warnings = WARN_GLITCHES.filter((k) => g[k] === true).map((k) => `${SAY[k]}${what}`)
  if (clone && !clone.passed) reasons.push('someone in the background looks like the lead')
  // Face consistency is hard (user, 2026-10-16); the check now compares against the chosen person's reference sheet.
  if (face && !face.passed) reasons.push(`the face differs from the chosen person: ${face.reason.replace(/^The lead is missing or looks different: /, '').replace(/\.+$/, '')}`)
  if (visible && visible.face_visible === true && visible.clearly_different === true) reasons.push(`the face differs from the chosen person: ${String(visible.why ?? '').replace(/\.+$/, '')}`)
  return { passed: reasons.length === 0, reasons, warnings }
}
