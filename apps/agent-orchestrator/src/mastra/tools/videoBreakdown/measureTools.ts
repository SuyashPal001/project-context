import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { fetchVideo } from './fetchVideo.js'
import { aiService, type CutsResult, type HiddenCutsResult, type SoundResult, type PoseResult } from './aiServiceClient.js'

type Ctx = { idToken: string; scopeId: string; conversationId: string }

function ctxOf(execContext: unknown): Ctx | null {
  const rc = (execContext as { requestContext?: { get(k: string): unknown } })?.requestContext
  const idToken = rc?.get('idToken') as string | undefined
  const tenantId = rc?.get('tenantId') as string | undefined
  const sessionId = rc?.get('sessionId') as string | undefined
  const conversationId = (rc?.get('conversationId') as string | undefined) ?? sessionId
  if (!idToken || !sessionId || !conversationId) return null
  return { idToken, scopeId: tenantId ?? sessionId, conversationId }
}

const wrap = async <T>(fn: () => Promise<T>) => {
  try { return { success: true, result: await fn() } } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) } }
}
// Over 90s: ask which part instead of running CPU-heavy work on the shared VM (review M1).
async function shortVideo(input: { url?: string; fileId?: string }, ctx: Ctx) {
  const v = await fetchVideo(input, ctx)
  if (v.tooLong) throw new Error(`The video is ${Math.round(v.durationS)}s long. Ask the user which part (up to 90s) to break down.`)
  return v
}
const out = z.object({ success: z.boolean(), result: z.any().optional(), error: z.string().optional() })
const src = z.object({ fileId: z.string().optional(), url: z.string().url().optional() })

export const findCutsTool = createTool({
  id: 'find_cuts',
  description: 'Free: exact hard-cut times and fade spans in a video (TransNetV2). Use these instead of times from watch_video.',
  inputSchema: src, outputSchema: out,
  execute: async (input, ec) => {
    const ctx = ctxOf(ec); if (!ctx) return { success: false, error: 'no_active_session' }
    return wrap(async () => aiService<CutsResult>('/media/cuts', { path: (await shortVideo(input, ctx)).filePath }))
  },
})

export const findHiddenCutsTool = createTool({
  id: 'find_hidden_cuts',
  description: 'Free: exact times of look changes that happen behind something covering the camera (a fan blade, a hand, a door). Only use when watch_video says change_style includes hidden_changes. Needs the looks (with rough times) from watch_video.',
  inputSchema: src.extend({ looks: z.array(z.object({ label: z.string(), approx_start_s: z.number(), approx_end_s: z.number() })).min(2), subject_box: z.array(z.number()).length(4).optional() }),
  outputSchema: out,
  execute: async (input, ec) => {
    const ctx = ctxOf(ec); if (!ctx) return { success: false, error: 'no_active_session' }
    return wrap(async () => aiService<HiddenCutsResult>('/media/hidden-cuts', { path: (await shortVideo(input, ctx)).filePath, looks: input.looks, subject_box: input.subject_box }))
  },
})

export const soundTimelineTool = createTool({
  id: 'sound_timeline',
  description: 'Free: exact sound timing — loudness every 0.5s, big jumps and drops, rhythmic patterns, when it goes silent, and the music tempo (BPM) with beat times. Trust this over any model’s sound timing.',
  inputSchema: src, outputSchema: out,
  execute: async (input, ec) => {
    const ctx = ctxOf(ec); if (!ctx) return { success: false, error: 'no_active_session' }
    return wrap(async () => aiService<SoundResult>('/media/sound', { path: (await shortVideo(input, ctx)).filePath }))
  },
})

export const measurePoseTool = createTool({
  id: 'measure_pose',
  description: 'Free: MEASURED body position from the video frames (pose joints + optical flow), never a model guess. Per look: leg side at the start and end (image-left / image-right / center / unknown) and body angle (slant); plus each leg move with its exact time and direction. Trust this over watch_video\'s leg_side. Give the looks (label, start_s, end_s) — e.g. from break_down_video — or leave them out to measure the whole video as one look. Pass subject_box and covered spans (exclude) when known.',
  inputSchema: src.extend({
    looks: z.array(z.object({ label: z.string(), start_s: z.number(), end_s: z.number() })).optional(),
    subject_box: z.array(z.number()).length(4).optional(),
    exclude: z.array(z.array(z.number()).length(2)).optional(),
  }),
  outputSchema: out,
  execute: async (input, ec) => {
    const ctx = ctxOf(ec); if (!ctx) return { success: false, error: 'no_active_session' }
    return wrap(async () => {
      const v = await shortVideo(input, ctx)
      const looks = input.looks?.length ? input.looks : [{ label: 'whole video', start_s: 0, end_s: v.durationS }]
      return aiService<PoseResult>('/media/pose', { path: v.filePath, looks, subject_box: input.subject_box, exclude: input.exclude ?? [] })
    })
  },
})
