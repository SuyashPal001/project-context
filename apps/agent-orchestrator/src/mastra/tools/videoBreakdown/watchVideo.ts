import type { BodyReading } from './aiServiceClient.js'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { linkSchema } from './links.js'
import { askGeminiVideo, parseModelJson, asObject } from './geminiVideo.js'
import { fetchVideo, type FetchedVideo } from './fetchVideo.js'

export const WATCH_PROMPT = `Watch and listen to this whole video. Describe only what you actually see and hear. Times are rough; other tools measure exact times.
Use IMAGE directions (image-left / image-right as the viewer sees the frame).
Return ONLY JSON with these keys:
{"format": "one line naming the video format",
 "layout": "full frame | split screen | picture-in-picture | other",
 "change_style": ["hard_cuts" and/or "hidden_changes" (the scene/outfit changes while something covers the camera) and/or "fades" and/or "near_still"],
 "looks": [{"label": "short name of this distinct look/scene, in order", "approx_start_s": 0, "approx_end_s": 0,
   "outfit": "pieces, colours, fabric, details", "expression": "mouth, eyes, mood, and whether it changes",
   "start_pose": "pose when this look is first revealed", "end_pose": "pose at the end of this look",
   "moves": [{"t_s": 0, "limb": "arm/hand/legs/head/body", "direction": "image-left|image-right|up|down|toward camera", "how": "exact movement"}],
   "leg_side": "image-left|image-right|center (where the lower legs and feet end up)"}],
 "subject_box": [x0, y0, x1, y1] as 0-1 fractions where the main subject sits most of the time, or null,
 "story": {"setup": "how it opens", "cause": "what action drives the change", "payoff": "how it ends"},
 "moments": [{"t_s": 0, "what": "every meaningful action or event, including small ones inside a shot (a gesture, a prop used, a switch pressed, text appearing)", "why_it_matters": "its job in the story", "story_beat": "true ONLY when this moment IS the story's setup, cause or payoff action (at most one each), not a small gesture"}],
 "setting": {"floor": "", "rug": "", "furniture": "", "light": "", "framing": "how much of the frame the subject fills"},
 "characters": [{"who": "short description of each OTHER person the story needs (someone the main person reacts to, talks to or looks at), not the main person and not passers-by", "when": "m:ss - m:ss on screen", "where": "where in the frame"}],
 "props": [{"prop": "", "where": "", "when": "", "stays_in_place": true, "part_of_trick": "true ONLY when this object IS the trick (it covers the camera, wipes the frame or hides the change), not something that is simply in the scene"}],
 "trick": "the single mechanic that makes this video work, including what covers the camera and from where, if anything",
 "sound": "music / voice / sound effects summary", "voice_lines": "verbatim spoken words or null",
 "music": {"mood": "", "genre": "", "instruments": "", "has_vocals": true, "song_name": "ONLY if the song title is shown on screen or in the post caption; otherwise null — never guess"},
 "on_screen_text": ["exact text"],
 "keep_for_clone": [], "swap_for_clone": [], "never_copy": ["the exact music track, real faces, logos, verbatim script, anything else protected"]}`

const STYLES = new Set(['hard_cuts', 'hidden_changes', 'fades', 'near_still'])

export interface WatchOverview {
  format: string; layout: string; change_style: Array<'hard_cuts' | 'hidden_changes' | 'fades' | 'near_still'>
  looks: Array<{ label: string; approx_start_s: number; approx_end_s: number; outfit?: string; expression?: string; start_pose?: string; end_pose?: string; moves?: Array<{ t_s: number; limb: string; direction: string; how: string; measured?: boolean }>; leg_side?: string; leg_side_start?: string; leg_side_source?: 'measured' | 'gemini'; body_angle?: number | null; body?: { people: number | null; no_person: boolean | null; start: BodyReading | null; end: BodyReading | null }; measured?: string }>
  subject_box: [number, number, number, number] | null
  story: { setup: string; cause: string; payoff: string }
  moments: Array<{ t_s: number; what: string; why_it_matters: string; measured?: boolean; story_beat?: boolean }>
  setting: Record<string, string>
  props: Array<{ prop: string; where: string; when: string; stays_in_place?: boolean; part_of_trick?: boolean }>
  /** Other people the story needs (not the main person, not passers-by). Missing on older breakdowns. */
  characters?: Array<{ who: string; when: string; where: string }>
  trick: string; sound: string; voice_lines: string | null; on_screen_text: string[]
  music: { mood: string; genre: string; instruments: string; has_vocals: boolean | null; song_name: string | null }
  keep_for_clone: string[]; swap_for_clone: string[]; never_copy: string[]
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const clamp = (n: unknown) => Math.min(1, Math.max(0, Number(n) || 0))

export function normalizeOverview(v: Record<string, unknown>): WatchOverview {
  const box = Array.isArray(v.subject_box) && v.subject_box.length === 4 ? (v.subject_box.map(clamp) as [number, number, number, number]) : null
  const story = (v.story && typeof v.story === 'object' ? v.story : {}) as Record<string, unknown>
  return {
    format: str(v.format), layout: str(v.layout) || 'full frame',
    change_style: arr<string>(v.change_style).filter((s) => STYLES.has(s)) as WatchOverview['change_style'],
    looks: arr<WatchOverview['looks'][number]>(v.looks).filter((l) => l && typeof l.approx_start_s === 'number'),
    subject_box: box,
    story: { setup: str(story.setup), cause: str(story.cause), payoff: str(story.payoff) },
    moments: arr(v.moments), setting: (v.setting && typeof v.setting === 'object' ? v.setting : {}) as Record<string, string>,
    props: arr(v.props), trick: str(v.trick), sound: str(v.sound),
    characters: arr<Record<string, unknown>>(v.characters).filter((c) => c && typeof c === 'object' && str(c.who).trim()).map((c) => ({ who: str(c.who), when: str(c.when), where: str(c.where) })),
    music: (() => { const m = (v.music && typeof v.music === 'object' ? v.music : {}) as Record<string, unknown>; return { mood: str(m.mood), genre: str(m.genre), instruments: str(m.instruments), has_vocals: typeof m.has_vocals === 'boolean' ? m.has_vocals : null, song_name: typeof m.song_name === 'string' && m.song_name ? m.song_name : null } })(),
    voice_lines: typeof v.voice_lines === 'string' ? v.voice_lines : null,
    on_screen_text: arr<string>(v.on_screen_text).filter((t) => typeof t === 'string'),
    keep_for_clone: arr(v.keep_for_clone), swap_for_clone: arr(v.swap_for_clone), never_copy: arr(v.never_copy),
  }
}

export async function watchVideo(video: Pick<FetchedVideo, 'filePath' | 'youtubeUrl' | 'durationS'>, tenantId?: string, fetchImpl?: typeof fetch): Promise<WatchOverview> {
  const { raw } = await askGeminiVideo({ video: video.youtubeUrl ? { youtubeUrl: video.youtubeUrl } : { filePath: video.filePath }, durationS: video.durationS, prompt: WATCH_PROMPT, tenantId, agentId: 'watch-video', fetchImpl })
  let obj = asObject(parseModelJson(raw), 'looks')
  // A reply nested under one key ({"overview": {...}}) is unwrapped.
  const keys = Object.keys(obj)
  if (keys.length === 1 && obj[keys[0]] && typeof obj[keys[0]] === 'object' && !Array.isArray(obj[keys[0]])) obj = obj[keys[0]] as Record<string, unknown>
  const o = normalizeOverview(obj)
  // Never a silently empty overview (review I2): no format, no looks and no change style means the reply was not an overview.
  if (!o.format && o.looks.length === 0 && o.change_style.length === 0) throw new Error('unreadable model reply')
  return o
}

export const watchVideoTool = createTool({
  id: 'watch_video',
  description: 'Watch and listen to a whole video once and return its overview: format, how scenes change, each look (outfit, expression, start/end pose, moves, leg side), story, moments, setting, props, the trick, sound and on-screen text. Rough times only — exact times come from find_cuts / find_hidden_cuts / sound_timeline.',
  inputSchema: z.object({ fileId: z.string().optional(), url: linkSchema.optional() }),
  outputSchema: z.object({ success: z.boolean(), overview: z.any().optional(), error: z.string().optional() }),
  execute: async (input, execContext) => {
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined
    const sessionId = execContext?.requestContext?.get('sessionId') as string | undefined
    const conversationId = (execContext?.requestContext?.get('conversationId') as string | undefined) ?? sessionId
    if (!idToken || !sessionId || !conversationId) return { success: false, error: 'no_active_session' }
    try {
      const video = await fetchVideo(input, { idToken, scopeId: tenantId ?? sessionId, conversationId })
      if (video.tooLong) return { success: false, error: `The video is ${Math.round(video.durationS)}s long. Ask the user which part (up to 90s) to break down.` }
      return { success: true, overview: await watchVideo(video, tenantId) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
})
