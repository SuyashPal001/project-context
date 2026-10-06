import { createHash } from 'node:crypto'

const stableToolCallId = (id: string): string => createHash('sha256').update(id).digest('hex')

// The live step list in chat ("Storyboard ✓ · Scene clip ✓ · Voice ◐ ·
// Joining"). Built here, from the tool calls themselves, so every ad type gets
// it without any prompt rule: each start and finish of a known tool — Olmo's
// own or one inside a delegate — becomes a `step` event. The browser groups
// events by key into rows. `kind` picks the animation shown on a running row.

export type StepKind = 'image' | 'video' | 'voice' | 'join' | 'finish' | 'check' | 'cast'
// waiting = held on the user's OK; skipped = cancelled, declined or stopped;
// credits = refused for want of credits.
export type StepState = 'running' | 'waiting' | 'done' | 'failed' | 'skipped' | 'credits'

export interface StepEvent {
  id: string
  key: string
  label: string
  kind: StepKind
  state: StepState
  /** Items in this call (a batch of 4 stills counts 4). */
  count: number
}

const STEPS: Record<string, { key: string; label: string; kind: StepKind }> = {
  generate_image: { key: 'pictures', label: 'Pictures', kind: 'image' },
  generate_images: { key: 'pictures', label: 'Pictures', kind: 'image' },
  edit_image: { key: 'edits', label: 'Picture edits', kind: 'image' },
  generate_video: { key: 'clips', label: 'Video clips', kind: 'video' },
  generate_videos: { key: 'clips', label: 'Video clips', kind: 'video' },
  generate_narration: { key: 'voice', label: 'Voice', kind: 'voice' },
  lipsync: { key: 'voice', label: 'Voice', kind: 'voice' },
  mux_beat_audio: { key: 'voice-mix', label: 'Laying the voice', kind: 'voice' },
  mix_voiceover: { key: 'voice-mix', label: 'Laying the voice', kind: 'voice' },
  assemble_clips: { key: 'join', label: 'Joining the scenes', kind: 'join' },
  trim_clip: { key: 'join', label: 'Joining the scenes', kind: 'join' },
  stretch_clip: { key: 'join', label: 'Joining the scenes', kind: 'join' },
  composite_end_card: { key: 'end-card', label: 'End card', kind: 'join' },
  overlay_text: { key: 'text', label: 'On-screen text', kind: 'join' },
  transcribe_audio: { key: 'captions', label: 'Captions', kind: 'finish' },
  burn_captions: { key: 'captions', label: 'Captions', kind: 'finish' },
  generate_song: { key: 'music', label: 'Music', kind: 'finish' },
  generate_jingle: { key: 'music', label: 'Music', kind: 'finish' },
  mix_music_bed: { key: 'music', label: 'Music', kind: 'finish' },
  tighten_pauses: { key: 'tighten', label: 'Trimming pauses', kind: 'finish' },
  check_clip: { key: 'checks', label: 'Quality checks', kind: 'check' },
  roll_avatar_variations: { key: 'casting', label: 'Casting', kind: 'cast' },
  roll_character_variations: { key: 'casting', label: 'Casting', kind: 'cast' },
  roll_tvc_variations: { key: 'casting', label: 'Casting', kind: 'cast' },
  save_as_avatar: { key: 'saving', label: 'Saving the avatar', kind: 'finish' },
}

const norm = (name: string) => name.replace(/-/g, '_')

const isStoryboard = (args: Record<string, unknown>): boolean => {
  const titles = [args.title, ...(Array.isArray(args.items) ? args.items.map((i) => (i as Record<string, unknown>)?.title) : [])]
  return titles.some((t) => typeof t === 'string' && /storyboard/i.test(t))
}

/** The step a tool call starts, or null for tools that are not a visible step. */
export function stepStart(toolName: string, toolCallId: string, args: Record<string, unknown> = {}): StepEvent | null {
  const step = STEPS[norm(toolName)]
  if (!step) return null
  const storyboard = step.key === 'pictures' && isStoryboard(args)
  const count = Array.isArray(args.items) ? args.items.length : Array.isArray(args.blocks) ? 1 : 1
  return {
    id: `step-${stableToolCallId(toolCallId || JSON.stringify(args)).slice(0, 16)}`,
    ...(storyboard ? { key: 'storyboard', label: 'Storyboard', kind: 'image' as const } : step),
    state: 'running',
    count,
  }
}

/**
 * The same step finished: done; skipped when cancelled or declined; credits
 * when refused for want of credits; failed when the tool refused or a check
 * did not pass.
 */
export function stepEnd(start: StepEvent, result: unknown): StepEvent {
  const r = (result ?? {}) as Record<string, unknown>
  if (r.insufficientCredits === true) return { ...start, state: 'credits' }
  if (r.cancelled === true || r.declined === true) return { ...start, state: 'skipped' }
  const failed = r.refused === true || r.failed === true
    || (start.key === 'checks' && r.passed === false)
    || (typeof r.failed === 'number' && typeof r.succeeded === 'number' && r.succeeded === 0)
  return { ...start, state: failed ? 'failed' : 'done' }
}
