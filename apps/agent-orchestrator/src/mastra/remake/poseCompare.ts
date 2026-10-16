// The still's measured body against the reference look's measured body. Free and exact;
// general for any reel (no assumption about lying down, leg sides or one person).
import type { BodyReading, ImagePose } from '../tools/videoBreakdown/aiServiceClient.js'
import type { CheckResult } from '../scorers/video/gate.js'
import { kneesInShot, kneeSideClear } from '../tools/videoBreakdown/measuredLine.js'

const FRAMINGS = ['full_body', 'knees_up', 'waist_up', 'chest_up', 'face']
const WORD: Record<string, string> = { full_body: 'full body', knees_up: 'knees up', waist_up: 'waist up', chest_up: 'chest up', face: 'face close-up' }
const known = (v: unknown) => v !== null && v !== undefined && v !== 'unknown'
const result = (status: CheckResult['status'], reason: string): CheckResult => ({ name: 'pose', status, reason, evidenceTimes: [] })

export function comparePose(ref: BodyReading | null, refPeople: number | null, got: ImagePose): CheckResult {
  if (refPeople === 0) return got.people === 0 ? result('pass', 'no person, as in the reference') : result('fail', 'a person appears where the reference has none')
  if (refPeople === null || !ref) return result('unknown', 'the reference body was not measured')
  if (got.people === 0 || !got.main) return result('fail', 'no person found in the still')
  if (refPeople === 1 && got.people > 1) return result('fail', `extra person: ${got.people} people in the still, 1 in the reference`)
  if (refPeople > 1 && got.people < 2) return result('fail', `only ${got.people} person in the still, ${refPeople} in the reference`)
  const g = got.main
  const diffs: string[] = []
  const unread: string[] = []
  const field = (name: string, a: unknown, b: unknown, same: (a: string, b: string) => boolean, say: (a: string, b: string) => string) => {
    if (!known(a)) return
    if (!known(b)) { unread.push(name); return }
    if (!same(String(a), String(b))) diffs.push(say(String(a), String(b)))
  }
  field('framing', ref.framing, g.framing, (a, b) => Math.abs(FRAMINGS.indexOf(a) - FRAMINGS.indexOf(b)) <= 1,
    (a, b) => `framing: reference ${WORD[a] ?? a}, still ${WORD[b] ?? b}`)
  if (ref.torso_angle_deg !== null && g.torso_angle_deg !== null) {
    const d = Math.abs(ref.torso_angle_deg - g.torso_angle_deg) % 360
    if (Math.min(d, 360 - d) > 25) diffs.push(`body angle: reference ${Math.round(ref.torso_angle_deg)}°, still ${Math.round(g.torso_angle_deg)}°`)
  } else {
    field('orientation', ref.orientation, g.orientation, (a, b) => a === b, (a, b) => `body: reference ${a}, still ${b}`)
  }
  // Knees the reference frame does not show are not compared (they were guessed off-frame).
  if (kneesInShot(ref)) field('knees', ref.knees, g.knees, (a, b) => a === b, (a, b) => `knees: reference ${a}, still ${b}`)
  if (kneeSideClear(ref)) field('knee side', ref.knees_toward, g.knees_toward, (a, b) => a === b, (a, b) => `knees fall to ${b} in the still, ${a} in the reference`)
  for (const side of ['left', 'right'] as const) {
    field(`${side} arm`, ref.arms[side], g.arms[side], (a, b) => (a === 'raised') === (b === 'raised'),
      (a) => `${side} arm: ${a === 'raised' ? 'raised in the reference, not in the still' : 'raised in the still, not in the reference'}`)
  }
  if (diffs.length) return result('fail', diffs.join('; '))
  if (unread.length) return result('unknown', `could not read in the still: ${unread.join(', ')}`)
  return result('pass', 'pose matches the reference')
}
