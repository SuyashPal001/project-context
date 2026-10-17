// New music in the reference's mood (spec §9a): the original track is never copied.
import type { RemakePlan } from './types.js'

export function musicPrompt(plan: RemakePlan): string {
  const swap = plan.lines.find((l) => l.ref === 'sound.music')
  const m = plan.reference.music
  const userWords = swap?.action === 'swap' && swap.to && !swap.to.startsWith('new music, same mood') ? swap.to : null
  const feel = userWords ?? [m.mood, m.genre].filter(Boolean).join(' ')
  // an instrumental track never names voices (", vocals. No vocals" was refused as recitation, fan run real31)
  const kit = (m.instruments ?? '').split(/,\s*/).filter((x) => x && !/vocal|voice|singer|choir|chant/i.test(x)).join(', ')
  const instruments = !userWords && kit ? `, with ${kit}` : ''
  return `An original instrumental track, ${feel || 'light and modern'}${instruments}. No vocals, no lyrics. A steady beat suited to a short social video.`
}

/** A plainer second try when the music model refuses the first (as recitation, fan run real31): the mood only,
 *  no genre or instrument names that can read as an existing song. */
export function plainMusicPrompt(plan: RemakePlan): string {
  const mood = (plan.reference.music.mood || 'warm').split(/[,/]/)[0].trim().toLowerCase()
  return `An original light instrumental track, ${mood} and modern, with a gentle steady beat for a short fashion video. No vocals.`
}
