// The remake's own split of the still checks (user's call, 2026-10-16): a HARD fault gets one paid
// retry; a WARNING keeps the still and shows the user what may be off. Made-up text on signs is a
// warning ("not always that bad"). The face is hard, judged against the chosen person's reference
// sheet (front, 3/4, profile, full body), not a small front crop. The TVC checks are unchanged.
import { askChecked, checkLeadClone, checkLeadFace, GLITCH_QUESTION, type AskFn, type Img } from '../tools/tvcChecks.js'

const HARD_GLITCHES = ['duplicate_object', 'stray_face', 'cg_effect', 'flat_background'] as const
const WARN_GLITCHES = ['invented_text'] as const
const SAY: Record<string, string> = { duplicate_object: 'an object appears twice', stray_face: 'a face where none belongs', cg_effect: 'a cartoon or CG effect', flat_background: 'a flat graphic background', invented_text: 'made-up text on a sign or object' }

export interface StillVerdict { passed: boolean; reasons: string[]; warnings: string[] }

export async function remakeStillChecks(ask: AskFn, still: Img, opts: { lead?: Img; leadInShot?: boolean }): Promise<StillVerdict> {
  const [g, face, clone] = await Promise.all([
    askChecked(ask, [{ image: still }, { text: GLITCH_QUESTION }], [...HARD_GLITCHES, ...WARN_GLITCHES].map((key) => ({ key, type: 'boolean' as const }))),
    opts.lead && opts.leadInShot ? checkLeadFace(ask, opts.lead, still) : null,
    opts.lead ? checkLeadClone(ask, opts.lead, [still]) : null,
  ])
  const what = g.what ? ` (${String(g.what)})` : ''
  const reasons = HARD_GLITCHES.filter((k) => g[k] === true).map((k) => `${SAY[k]}${what}`)
  const warnings = WARN_GLITCHES.filter((k) => g[k] === true).map((k) => `${SAY[k]}${what}`)
  if (clone && !clone.passed) reasons.push('someone in the background looks like the lead')
  // Face consistency is hard (user, 2026-10-16); the check now compares against the chosen person's reference sheet.
  if (face && !face.passed) reasons.push(`the face differs from the chosen person: ${face.reason.replace(/^The lead is missing or looks different: /, '').replace(/\.+$/, '')}`)
  return { passed: reasons.length === 0, reasons, warnings }
}
