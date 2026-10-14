import { aiService } from './aiServiceClient.js'
import type { WatchOverview } from './watchVideo.js'

type Box = [number, number, number, number]
const DEFAULT_BOX: Box = [0.1, 0.1, 0.9, 0.9]
const r2 = (n: number) => Math.round(n * 100) / 100

// Gemini says WHAT happens; code says exactly WHEN (spec §8a).
export function limbBox(limb: string, subject: Box | null): Box {
  const [x0, y0, x1, y1] = subject ?? DEFAULT_BOX
  const h = y1 - y0
  if (/leg|feet|foot|knee/i.test(limb)) return [x0, r2(y0 + h * 0.45), x1, y1]
  if (/head|face/i.test(limb)) return [x0, y0, x1, r2(y0 + h * 0.2)]
  return [x0, y0, x1, y1]
}

export async function refineMoments(filePath: string, overview: WatchOverview, exclude: Array<[number, number]>, fetchImpl?: typeof fetch): Promise<{ overview: WatchOverview; refined: number; unmeasured: number }> {
  const subject = (overview.subject_box ?? null) as Box | null
  const items: Array<{ id: string; t_s: number; box: Box }> = []
  overview.moments.forEach((m, i) => items.push({ id: `m${i}`, t_s: m.t_s, box: limbBox(m.what, subject) }))
  overview.looks.forEach((l, j) => (l.moves ?? []).forEach((v, k) => items.push({ id: `l${j}-v${k}`, t_s: v.t_s, box: limbBox(v.limb, subject) })))
  const byId = new Map<string, { t_s: number; measured: boolean }>()
  if (items.length) {
    try {
      const r = await aiService<{ items: Array<{ id: string; t_s: number; measured: boolean }> }>('/media/motion-peaks', { path: filePath, items, exclude, window_s: 1.5 }, fetchImpl)
      for (const it of r.items) byId.set(it.id, { t_s: it.t_s, measured: it.measured })
    } catch { /* unmeasured below; never a guess presented as measured */ }
  }
  let refined = 0, unmeasured = 0
  const apply = <T extends { t_s: number; measured?: boolean }>(x: T, id: string): T => {
    const hit = byId.get(id)
    if (hit?.measured) { refined++; return { ...x, t_s: hit.t_s, measured: true } }
    unmeasured++
    return { ...x, measured: false }
  }
  const out: WatchOverview = {
    ...overview,
    moments: overview.moments.map((m, i) => apply(m, `m${i}`)),
    looks: overview.looks.map((l, j) => ({ ...l, moves: (l.moves ?? []).map((v, k) => apply(v, `l${j}-v${k}`)) })),
  }
  return { overview: out, refined, unmeasured }
}
