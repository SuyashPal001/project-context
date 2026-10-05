// In a talking-head or UGC ad the user reviews every video before paying for
// the next one. 2026-10-05: Director made the opening clip, its check failed,
// and it went straight into a paid redo — the approval card appeared before
// the user had seen the first clip, because a delegate's results only reach
// the chat when its turn ends. A prompt rule against this was not enough, so
// the video tools allow one video call per turn in these flows: after one,
// the next gets no approval card and is refused until the user has replied.

type ContextLike = { get?: (key: string) => unknown; set?: (key: string, value: unknown) => void } | Record<string, unknown> | undefined

const VIDEO_MADE = 'videoMadeThisTurn'
const CHECK_FAILED = 'checkFailedThisTurn'

function read(ctx: ContextLike, key: string): unknown {
  if (!ctx) return undefined
  if (typeof (ctx as { get?: unknown }).get === 'function') return (ctx as { get: (k: string) => unknown }).get(key)
  return (ctx as Record<string, unknown>)[key]
}

/** True when Director's own messages carry a reviewed ad flow's marker. Read
 * from the messages, not set at the first step: after an approval the run
 * resumes mid-turn and a first-step mark would be missing. */
export function isReviewedAdFlow(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false
  const text = JSON.stringify(messages).toLowerCase()
  return REVIEWED_FLOW_MARKERS.some((m) => text.includes(m))
}

function set(ctx: ContextLike, key: string): void {
  if (ctx && typeof (ctx as { set?: unknown }).set === 'function') (ctx as { set: (k: string, v: unknown) => void }).set(key, true)
}

/** Called after a video call produced at least one video. In Auto mode the
 * user chose not to be stopped for money, so a good video does not stop the
 * run — only a failed check does (markCheckFailed). */
export function markVideoMade(ctx: ContextLike, messages: unknown): void {
  if (read(ctx, 'allowMode') === 'auto') return
  if (isReviewedAdFlow(messages)) set(ctx, VIDEO_MADE)
}

/** Called when check_clip fails a clip in an ad flow: in either mode, nothing
 * more is paid for in this turn — the user sees the problem first. */
export function markCheckFailed(ctx: ContextLike, messages: unknown): void {
  if (isReviewedAdFlow(messages)) set(ctx, CHECK_FAILED)
}

/** True when this turn must stop paying for media: a video was made (Ask
 * mode) or a clip failed its check (either mode). */
export function videoBlockedThisTurn(ctx: ContextLike): boolean {
  return !!read(ctx, VIDEO_MADE) || !!read(ctx, CHECK_FAILED)
}

export const SHOW_FIRST_REFUSAL = {
  refused: true as const,
  refusalReason: 'SHOW_FIRST: a video was already made in this turn of the ad, or a clip failed its check. Stop and return what was made (fileId, interactionId, any check problem) to Olmo so the user sees it and decides before the next video.',
}

/** The same stop for paid follow-on steps (narration, lip-sync, music) once a
 * video was made this turn: the user sees the clips before anything is built
 * on top of them. */
export const SHOW_FIRST_FOLLOW_ON_REFUSAL = {
  refused: true as const,
  refusalReason: 'SHOW_FIRST: videos were made in this turn of the ad. Stop and return them to Olmo so the user sees them first; voice, lip-sync and music come in the next turn, after the user replies.',
}

/** The ad flows where the user reviews each video. Every ad flow that renders
 * video: 2026-10-05 the animated story ad rendered 4 clips and went straight on
 * to paid narration before the user had seen one of them. The TVC ad follows
 * the same policy: one moment per turn in Ask mode, and a failed check stops. */
export const REVIEWED_FLOW_MARKERS = ['flow: talking head', 'flow: ugc ad', 'flow: first frame', 'flow: animation character ad', 'flow: short drama stitch', 'flow: tvc ad']
