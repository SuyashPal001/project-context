import type { BodyReading, PoseLookResult, PoseMove } from './aiServiceClient.js'

// One plain sentence per look built from the MEASURED body reading, so the agent can
// copy it into its reply instead of re-describing poses from the model's watch (which
// read leg sides and orientation wrong). General words for any reel; no internal names.
const FRAMING: Record<string, string> = { full_body: 'full body', knees_up: 'knees up', waist_up: 'waist up', chest_up: 'chest up', face: 'face close-up' }
const ORIENTATION: Record<string, string> = { vertical: 'upright in frame', horizontal: 'sideways in frame', diagonal: 'tilted in frame' }
const AREA: Record<string, string> = { upper: 'upper body', lower: 'legs' }
const dir = (d: string) => d.split(' + ').map((x) => x.replace('image-', '')).join(' and ')
const known = (v: string | null | undefined) => v && v !== 'unknown'

// Legs out of shot were still "read" (keypoints guessed off-frame) and the words made an image
// model draw a full body for a waist-up shot (live Snitch run, 2026-10-16).
const KNEES_SHOWN = new Set(['full_body', 'knees_up', 'unknown'])
const FEET_SHOWN = new Set(['full_body', 'unknown'])
export const kneesInShot = (b: BodyReading): boolean => KNEES_SHOWN.has(b.framing ?? 'unknown')


export function personWords(b: BodyReading, start: BodyReading | null): string[] {
  const w: string[] = []
  const knees = kneesInShot(b), feet = FEET_SHOWN.has(b.framing ?? 'unknown')
  if (known(b.framing)) w.push(FRAMING[b.framing] ?? b.framing)
  if (b.facing === 'back') w.push('back to the camera')
  else if (b.facing === 'side') w.push('side-on to the camera')
  if (known(b.orientation)) w.push(b.orientation === 'diagonal' && b.torso_angle_deg !== null ? `tilted about ${Math.round(Math.abs(b.torso_angle_deg))}° in frame` : ORIENTATION[b.orientation])
  if (knees && known(b.knees)) w.push(`knees ${b.knees}`)
  for (const side of ['left', 'right'] as const) {
    if (b.arms?.[side] === 'raised') w.push(`${side} arm raised`)
  }
  if (knees && known(b.knees_toward) && b.knees_toward !== 'center') {
    const before = start && known(start.knees_toward) && start.knees_toward !== b.knees_toward ? ` (at the start: ${start.knees_toward})` : ''
    w.push(`knees fall to ${b.knees_toward}${before}`)
  }
  if (feet && known(b.feet_toward) && b.feet_toward !== 'center' && b.feet_toward !== b.knees_toward) w.push(`feet to ${b.feet_toward}`)
  return w
}

export function measuredLine(look: PoseLookResult, moves: PoseMove[]): string {
  if (look.no_person) return 'Measured: no person in shot'
  const b = look.main_end ?? look.main_start
  if (look.people === null || !b) return 'Measured: body not readable in this part'
  const words = personWords(b, look.main_end ? look.main_start : null)
  const head = look.people === 1 ? '1 person' : `${look.people} people; main person:`
  let line = `Measured: ${head}${words.length ? (look.people === 1 ? ', ' : ' ') + words.join(', ') : ''}`
  const inside = moves.filter((m) => m.t_s >= look.start_s && m.t_s < look.end_s)
  if (inside.length) line += `; moves: ${inside.map((m) => `${AREA[m.area] ?? m.area} ${dir(m.direction)} at ${m.t_s.toFixed(1)}s`).join(', ')}`
  return line
}
