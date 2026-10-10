import { legalTimings, shotStarts, type TvcPlan } from './tvcPlan.js'
import { formatAssTimestamp, resolveLegalBands, type TextOverlay } from './overlayText.js'

// The TVC animatic (spec 2026-10-10): the approved stills as a timed rough cut,
// with the real voiceover, music, end card and text, before any video is paid
// for. Everything here is pure; renderAnimatic.ts runs the ffmpeg passes.

export const ANIMATIC_FPS = 24 // Omni renders at 24 and assemble_clips keeps 24
export const PUSH_IN = 0.04
export const MAX_OVERLAYS = 12 // overlay_text's own cap
const r6 = (x: number) => Math.round(x * 1e6) / 1e6

export function frameSize(aspectRatio: '16:9' | '9:16'): { width: number; height: number } {
  return aspectRatio === '9:16' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 }
}

/** Frames per shot from cumulative boundaries, so the total is exactly round(length × fps). */
export function segmentFrames(durations: number[], fps = ANIMATIC_FPS): number[] {
  const out: number[] = []
  let t = 0
  let prev = 0
  for (const d of durations) {
    t += d
    const edge = Math.round(t * fps + 1e-9)
    out.push(edge - prev)
    prev = edge
  }
  return out
}

/** Each shot's still. A continuing shot has none of its own (planTvc refuses one) and uses the shot it continues. */
export function stillSources(plan: TvcPlan): Array<string | undefined> {
  const out: Array<string | undefined> = []
  plan.shots.forEach((s, i) => {
    const from = s.continuesFrom !== undefined ? plan.shots.findIndex((p) => p.n === s.continuesFrom) : -1
    out.push(from >= 0 && from < i ? out[from] : s.stillFileId)
  })
  return out
}

/** Shot numbers that still need a still before an animatic can be made. */
export function missingStills(plan: TvcPlan): number[] {
  const sources = stillSources(plan)
  return plan.shots.filter((s, i) => !sources[i]).map((s) => s.n)
}

/** The zoom at each shot's first and last frame: 1.00 to 1.04, carried on through a continuing shot. */
export function zoomRanges(plan: TvcPlan): Array<[number, number]> {
  const out: Array<[number, number]> = []
  plan.shots.forEach((s, i) => {
    const from = s.continuesFrom !== undefined ? plan.shots.findIndex((p) => p.n === s.continuesFrom) : -1
    if (from >= 0 && from < i) {
      const z0 = out[from][1]
      out.push([z0, r6(z0 + PUSH_IN * (s.durationSeconds / plan.shots[from].durationSeconds))])
    } else {
      out.push([1, r6(1 + PUSH_IN)])
    }
  })
  return out
}

/** The recorded audio an animatic still needs. */
export function missingAudio(plan: TvcPlan): string[] {
  const out: string[] = []
  if (plan.voiceover.length > 0 && !plan.narrationFileIds) out.push('narration')
  if (!plan.songFileId) out.push('music')
  if (plan.brief.jingle && plan.signoffSeconds === undefined) out.push('sung sign-off')
  return out
}

/** One still to `frames` frames: fitted into the frame (never stretched), supersampled ×2 so a 4% zoom never stair-steps, then a centred linear zoom. */
export function pushInFilter(width: number, height: number, frames: number, zoom: [number, number]): string {
  const [z0, z1] = zoom
  const step = r6(z1 - z0)
  return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
    `scale=${width * 2}:${height * 2},` +
    `zoompan=z='${z0}+${step}*on/${Math.max(frames - 1, 1)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${ANIMATIC_FPS},` +
    'setsar=1,format=yuv420p'
}

/** The finish's on-screen text, built in code from the rules Director follows (director.md): shot text top/medium,
 *  the tagline over the packshot centre/large, prices stamped, legal lines at the bottom, at most 12 with shot texts
 *  dropped from the middle first. Face avoidance is skipped in a rough cut. */
export function animaticOverlays(plan: TvcPlan): TextOverlay[] | { refusalReason: string } {
  const legalOut = legalTimings(plan)
  if (legalOut.errors.length) return { refusalReason: `LEGAL_TIMING_ERRORS: ${legalOut.errors.join(' ')}` }
  const starts = shotStarts(plan)
  const length = plan.brief.lengthSeconds
  const logo = !!plan.brief.logoFileId
  const endOf = (i: number) => (i + 1 < plan.shots.length ? starts[i + 1] : length)
  const legal: TextOverlay[] = legalOut.timings.flatMap((t) => (t ? [{ text: t.text, startSeconds: t.startSeconds, endSeconds: t.endSeconds, position: 'bottom' as const, size: 'legal' as const }] : []))
  const texts: TextOverlay[] = []
  const prices: TextOverlay[] = []
  let tagline: TextOverlay | undefined
  plan.shots.forEach((s, i) => {
    const pack = s.type === 'packshot'
    if (s.text) texts.push({ text: s.text, startSeconds: starts[i], endSeconds: endOf(i), position: pack && logo ? 'center' : 'top', size: 'medium', ...(s.motion ? { motion: s.motion } : {}) })
    if (s.price) prices.push({ text: s.price.amount, startSeconds: starts[i], endSeconds: endOf(i), position: pack && !logo ? 'top' : 'center', price: s.price })
    if (pack && plan.packshot.tagline) tagline = { text: plan.packshot.tagline, startSeconds: starts[i], endSeconds: length, position: 'center', size: 'large', ...(plan.packshot.motion ? { motion: plan.packshot.motion } : {}) }
  })
  const fixed = legal.length + prices.length + (tagline ? 1 : 0)
  if (fixed > MAX_OVERLAYS) return { refusalReason: `ANIMATIC_TOO_MUCH_TEXT: ${fixed} disclaimers, prices and the tagline are more than the ${MAX_OVERLAYS} texts a video can carry; remove some` }
  while (texts.length > 0 && fixed + texts.length > MAX_OVERLAYS) texts.splice(Math.floor(texts.length / 2), 1)
  return resolveLegalBands([...legal, ...texts, ...prices, ...(tagline ? [tagline] : [])])
}

/** A small top-left ROUGH CUT mark over the whole ad, drawn by libass like the rest of the text. */
export function withRoughCutLabel(ass: string, lengthSeconds: number): string {
  const lines = ass.split('\n')
  const format = lines.findIndex((l) => l.startsWith('Format: Name,'))
  lines.splice(format + 1, 0, 'Style: rough-cut,DejaVu Sans,40,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,3,2,0,7,60,60,60,1')
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  lines.push(`Dialogue: 1,${formatAssTimestamp(0)},${formatAssTimestamp(lengthSeconds)},rough-cut,,0,0,0,,ROUGH CUT`, '')
  return lines.join('\n')
}

/** plan_tvc get "animatic": what Director needs to make the missing audio, and the order of steps. */
export function animaticSlice(plan: TvcPlan): { voiceover: TvcPlan['voiceover']; voiceId?: string; tier: string; category: string; jingle?: NonNullable<TvcPlan['brief']['jingle']>; recorded: { narration: boolean; music: boolean; signoff: boolean }; animaticOrder: string[] } {
  const missing = missingAudio(plan)
  const order: string[] = []
  if (missing.includes('narration')) order.push('generate_narration (one per voiceover block)')
  if (missing.includes('music')) order.push('generate_song')
  if (missing.includes('sung sign-off')) order.push('generate_jingle')
  if (order.length) order.push('plan_tvc record')
  order.push('render_animatic')
  return {
    voiceover: plan.voiceover,
    ...(plan.brief.voiceId ? { voiceId: plan.brief.voiceId } : {}),
    tier: plan.brief.tier, category: plan.brief.category,
    ...(plan.brief.jingle ? { jingle: plan.brief.jingle } : {}),
    recorded: { narration: !!plan.narrationFileIds, music: !!plan.songFileId, signoff: plan.signoffSeconds !== undefined },
    animaticOrder: order,
  }
}
