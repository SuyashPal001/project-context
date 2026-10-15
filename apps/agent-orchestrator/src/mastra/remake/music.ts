// New music in the reference's mood (spec §9a): the original track is never copied.
import type { RemakePlan } from './types.js'

export function musicPrompt(plan: RemakePlan): string {
  const swap = plan.lines.find((l) => l.ref === 'sound.music')
  const m = plan.reference.music
  const userWords = swap?.action === 'swap' && swap.to && !swap.to.startsWith('new music, same mood') ? swap.to : null
  const feel = userWords ?? [m.mood, m.genre].filter(Boolean).join(' ')
  const instruments = !userWords && m.instruments ? `, with ${m.instruments}` : ''
  return `An original instrumental track, ${feel || 'light and modern'}${instruments}. No vocals, no lyrics. A steady beat suited to a short social video.`
}
