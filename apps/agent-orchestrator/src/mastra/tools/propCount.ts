// Count the objects in a frame, and catch a clip that doubles or invents one against its approved start
// photo (two remotes: Omni 2026-10-17, the hand-made v4 2026-10-14). Shared by every clip check. A frame
// with no answer is unknown, never a pass.
import type { AskFn, Img } from './tvcChecks.js'

export const propCountQuestion = (props: string[]): string =>
  `Count how many of each of these objects are clearly visible in the image: ${props.map((p) => `"${p}"`).join(', ')}. Count each separate one; a part hidden behind a hand still counts once. Reply ONLY JSON {"counts": {"<object>": <number>}}`

export async function countProps(ask: AskFn, img: Img, props: string[]): Promise<Record<string, number | null>> {
  let counts: Record<string, unknown> = {}
  try { const r = await ask([{ image: img }, { text: propCountQuestion(props) }]); counts = (r.counts ?? {}) as Record<string, unknown> } catch { /* unknown */ }
  return Object.fromEntries(props.map((p) => [p, typeof counts[p] === 'number' ? (counts[p] as number) : null]))
}

export async function duplicatedProps(ask: AskFn, start: Img, frames: Array<{ t: number; img: Img }>, props: string[]): Promise<{ status: 'pass' | 'fail' | 'unknown'; reason: string }> {
  if (!props.length) return { status: 'pass', reason: 'no objects to count' }
  const [base, ...each] = await Promise.all([countProps(ask, start, props), ...frames.map((f) => countProps(ask, f.img, props))])
  const extra: string[] = []
  let known = false
  each.forEach((c, i) => props.forEach((p) => {
    const n = c[p]; const b = base[p]
    if (n === null || b === null) return
    known = true
    if (n > b) extra.push(`${n} ${p} at ${frames[i].t}s (the start photo has ${b})`)
  }))
  if (extra.length) return { status: 'fail', reason: `an object appears more often than in the start photo: ${extra.join('; ')}` }
  return known ? { status: 'pass', reason: 'each object appears as often as in the start photo' } : { status: 'unknown', reason: 'the objects could not be counted' }
}
