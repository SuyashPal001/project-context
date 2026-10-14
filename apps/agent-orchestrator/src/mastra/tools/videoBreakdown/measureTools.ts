import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { fetchVideo } from './fetchVideo.js'
import { aiService, type CutsResult, type HiddenCutsResult, type SoundResult } from './aiServiceClient.js'

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
const out = z.object({ success: z.boolean(), result: z.any().optional(), error: z.string().optional() })
const src = z.object({ fileId: z.string().optional(), url: z.string().url().optional() })

export const findCutsTool = createTool({
  id: 'find_cuts',
  description: 'Free: exact hard-cut times and fade spans in a video (TransNetV2). Use these instead of times from watch_video.',
  inputSchema: src, outputSchema: out,
  execute: async (input, ec) => {
    const ctx = ctxOf(ec); if (!ctx) return { success: false, error: 'no_active_session' }
    return wrap(async () => aiService<CutsResult>('/media/cuts', { path: (await fetchVideo(input, ctx)).filePath }))
  },
})

export const findHiddenCutsTool = createTool({
  id: 'find_hidden_cuts',
  description: 'Free: exact times of look changes that happen behind something covering the camera (a fan blade, a hand, a door). Only use when watch_video says change_style includes hidden_changes. Needs the looks (with rough times) from watch_video.',
  inputSchema: src.extend({ looks: z.array(z.object({ label: z.string(), approx_start_s: z.number(), approx_end_s: z.number() })).min(2), subject_box: z.array(z.number()).length(4).optional() }),
  outputSchema: out,
  execute: async (input, ec) => {
    const ctx = ctxOf(ec); if (!ctx) return { success: false, error: 'no_active_session' }
    return wrap(async () => aiService<HiddenCutsResult>('/media/hidden-cuts', { path: (await fetchVideo(input, ctx)).filePath, looks: input.looks, subject_box: input.subject_box }))
  },
})

export const soundTimelineTool = createTool({
  id: 'sound_timeline',
  description: 'Free: exact sound timing — loudness every 0.5s, big jumps and drops, rhythmic patterns, when it goes silent, and the music tempo (BPM) with beat times. Trust this over any model’s sound timing.',
  inputSchema: src, outputSchema: out,
  execute: async (input, ec) => {
    const ctx = ctxOf(ec); if (!ctx) return { success: false, error: 'no_active_session' }
    return wrap(async () => aiService<SoundResult>('/media/sound', { path: (await fetchVideo(input, ctx)).filePath }))
  },
})
