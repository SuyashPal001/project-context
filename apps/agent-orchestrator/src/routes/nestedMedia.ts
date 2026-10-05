import { stableToolCallId } from '../credits.js'

// A delegate's own tool calls never reach the browser: only the delegate
// wrapper's (agent-director) call does, and its result lands once the whole
// delegation ends. So a storyboard's stills all appeared at once at the end,
// or never while the turn waited on a question (2026-10-05 animated ad: "where
// is story board i dont see any of it"). Each finished image, video, song or
// show_files inside a delegate is relayed on its own as it completes, so the
// pictures appear one after another in chat while the delegate keeps working.
const RELAYED = new Set([
  'generate_image', 'generate-image', 'generate_images', 'generate-images',
  'edit_image', 'edit-image',
  'generate_video', 'generate-video', 'generate_videos', 'generate-videos',
  'generate_song', 'generate-song',
  'show_files',
])

export interface RelayedToolResult {
  toolCallId: string
  toolName: string
  result: Record<string, unknown>
}

/** The nested chunk of a delegate's tool-output part, when it is a finished media result worth showing now. */
export function relayedDelegateMedia(nested: unknown): RelayedToolResult | null {
  const chunk = nested as { type?: unknown; payload?: { toolName?: unknown; toolCallId?: unknown; result?: unknown; output?: unknown } } | null
  if (!chunk || chunk.type !== 'tool-result') return null
  const toolName = typeof chunk.payload?.toolName === 'string' ? chunk.payload.toolName : ''
  if (!RELAYED.has(toolName)) return null
  const result = (chunk.payload?.result ?? chunk.payload?.output) as Record<string, unknown> | undefined
  if (!result || typeof result !== 'object' || result.cancelled === true || result.failed === true) return null
  const rawId = typeof chunk.payload?.toolCallId === 'string' && chunk.payload.toolCallId ? chunk.payload.toolCallId : JSON.stringify(result)
  return { toolCallId: `sub-${stableToolCallId(rawId).slice(0, 24)}`, toolName, result }
}
