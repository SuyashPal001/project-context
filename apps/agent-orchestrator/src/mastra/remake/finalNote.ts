// The "what differs from the reference" note (spec §1.7, §3.5): plain words, nothing
// presented as fine that isn't, and the AI-label reminder (§11).
import type { CheckResult } from '../scorers/video/gate.js'
import type { ClipResult } from './paidClip.js'
import type { RemakePlan, StillResult } from './types.js'

const CHECK_WORDS: Record<string, string> = { 'brightness-jumps': 'sudden brightness changes', 'same-person': 'same person throughout' }
const plainCheck = (name: string) => CHECK_WORDS[name] ?? name.replace(/@[\d.]+$/, '').replace(/-/g, ' ')
const part = (ref: string) => ref.replace(/^looks\[(\d+)\]\.(\w+)$/, (_m, i, f) => `${f} in part ${Number(i) + 1}`)

export function differenceNote(o: { plan: RemakePlan; stills: StillResult[]; clips: ClipResult[]; checks: CheckResult[] | null }): string {
  const lines: string[] = []
  const changed = o.plan.lines.filter((l) => !l.auto && (l.action === 'swap' || l.action === 'drop') && l.ref !== 'sound.music' && l.ref !== 'cast')
    .map((l) => (l.action === 'swap' ? `${part(l.ref)} → ${l.to}` : `${part(l.ref)} left out`))
  if (changed.length) lines.push(`Changed on purpose: ${changed.join('; ')}.`)
  lines.push('New music in the same mood (the original song is never used).')
  for (const c of o.clips) {
    if (c.status === 'still' || c.status === 'blocked') lines.push(`Part ${c.look} stays a still: ${c.reasons.join('; ')}.`)
    else if (c.status === 'failed') lines.push(`Part ${c.look} didn’t pass its checks after a second try: ${c.reasons.join('; ')}.`)
    else if (c.status === 'unchecked') lines.push(`Part ${c.look} couldn’t be fully checked.`)
    if (c.fallback) lines.push(`Part ${c.look} was animated a simpler way after the first try was refused.`)
  }
  if (o.checks === null) lines.push('The comparison with the original couldn’t be run this time.')
  else {
    const fails = o.checks.filter((c) => c.status === 'fail').map((c) => plainCheck(c.name))
    const unknown = o.checks.filter((c) => c.status === 'unknown').map((c) => plainCheck(c.name))
    if (fails.length) lines.push(`Differs from the original on: ${[...new Set(fails)].join(', ')}.`)
    if (unknown.length) lines.push(`These couldn’t be checked: ${[...new Set(unknown)].join(', ')}.`)
  }
  lines.push('Label it as AI-generated when you post it.')
  return lines.join('\n')
}
