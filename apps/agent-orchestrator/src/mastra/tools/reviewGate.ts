import { REVIEWED_FLOW_MARKERS } from './oneVideoPerTurn.js'

// Look at the first, then make the rest. In an ad, every later still is built
// from scene 1's still (same room, outfit, product) and every later clip
// follows the first clip's look and voice, so a fault in the first one is
// copied into all of them. In Ask mode a batch of stills or clips is refused
// until the user has looked at the first one through review_shots; the Director
// then makes the first one alone and hands it back. Enforced here, not in a
// prompt: 2026-10-06 a Lakmē ad made stills 2 and 3 straight after still 1, and
// scene 3 came back with an extra arm that only a review could catch.

export type ShotKind = 'still' | 'clip'

const REVIEW_TTL_MS = 6 * 60 * 60 * 1000
const reviewed = new Map<string, { still?: number; clip?: number }>()

type ContextLike = { get?: (key: string) => unknown; set?: (key: string, value: unknown) => void } | Record<string, unknown> | undefined

function read(ctx: ContextLike, key: string): unknown {
  if (!ctx) return undefined
  if (typeof (ctx as { get?: unknown }).get === 'function') return (ctx as { get: (k: string) => unknown }).get(key)
  return (ctx as Record<string, unknown>)[key]
}

/** The user looked at the first shot of this kind and said continue. */
export function markShotReviewed(conversationId: string | undefined, kind: ShotKind): void {
  if (!conversationId) return
  reviewed.set(conversationId, { ...reviewed.get(conversationId), [kind]: Date.now() })
  if (reviewed.size > 5000) reviewed.delete(reviewed.keys().next().value as string)
}

export function shotReviewed(conversationId: string | undefined, kind: ShotKind): boolean {
  const at = conversationId ? reviewed.get(conversationId)?.[kind] : undefined
  return at !== undefined && Date.now() - at < REVIEW_TTL_MS
}

// What check_clip last said about each clip, so review_shots never offers
// "All good" as the safe pick for a clip the check already failed.
// 2026-10-06 (Lakmē): scene 3 ended mid-sentence, check_clip caught it, and
// the review still recommended continuing; the cut line went into the ad.
const clipChecks = new Map<string, { passed: boolean; reason: string; at: number }>()

export function noteClipCheck(fileId: string | undefined, passed: boolean, reason: string): void {
  if (!fileId) return
  clipChecks.set(fileId, { passed, reason, at: Date.now() })
  if (clipChecks.size > 5000) clipChecks.delete(clipChecks.keys().next().value as string)
}

/** The reason a clip failed its last check, or undefined if it passed or was never checked. */
export function clipCheckFailure(fileId: string): string | undefined {
  const c = clipChecks.get(fileId)
  return c && !c.passed && Date.now() - c.at < REVIEW_TTL_MS ? c.reason : undefined
}

/** Set on the turn's request context when Olmo hands an ad flow to the Director. */
export const AD_FLOW_KEY = 'reviewedAdFlow'

export function briefIsReviewedAdFlow(prompt: unknown): boolean {
  if (typeof prompt !== 'string') return false
  const text = prompt.toLowerCase()
  return REVIEWED_FLOW_MARKERS.some((m) => text.includes(m))
}

/** True when this batch must wait: an ad flow in Ask mode, more than one item, and the first one not looked at yet. */
export function firstShotUnreviewed(ctx: ContextLike, kind: ShotKind, count: number): boolean {
  if (count <= 1) return false
  if (read(ctx, 'allowMode') === 'auto') return false
  if (read(ctx, AD_FLOW_KEY) !== true) return false
  return !shotReviewed(read(ctx, 'conversationId') as string | undefined, kind)
}

export function firstShotRefusal(kind: ShotKind) {
  const tool = kind === 'still' ? 'generate_image' : 'generate_video'
  return {
    refused: true as const,
    refusalReason: `FIRST_ONE_FIRST: the user has not looked at the first ${kind} of this ad yet. Make only the first scene's ${kind} with ${tool}, then stop and return it to Olmo, who shows it with review_shots. Make the rest only after the user says continue.`,
  }
}

// The product photo and avatar a creative brief came with, per conversation,
// so a later turn's review can check stills against them without the model
// having to pass them. The web's brief reads "- Product: <name>" and
// "- Avatar: <name> · …", and attaches each picture under that name.
const briefRefs = new Map<string, { productFileId?: string; avatarFileId?: string; at: number }>()

const stem = (name: string) => name.replace(/\.[a-z0-9]+$/i, '').trim().toLowerCase()

export function noteBriefRefs(conversationId: string | undefined, message: string, attachments: Array<{ fileId?: string; name?: string }>): void {
  if (!conversationId || !message.includes('Creative brief:')) return
  const find = (label: string) => {
    const name = message.match(new RegExp(`^- ${label}: ([^·\\n]+)`, 'm'))?.[1]?.trim().toLowerCase()
    return name ? attachments.find((a) => a.fileId && a.name && stem(a.name) === name)?.fileId : undefined
  }
  const productFileId = find('Product')
  const avatarFileId = find('Avatar')
  if (!productFileId && !avatarFileId) return
  briefRefs.set(conversationId, { productFileId, avatarFileId, at: Date.now() })
  if (briefRefs.size > 5000) briefRefs.delete(briefRefs.keys().next().value as string)
}

export function briefRefsFor(conversationId: string | undefined): { productFileId?: string; avatarFileId?: string } {
  const r = conversationId ? briefRefs.get(conversationId) : undefined
  return r && Date.now() - r.at < REVIEW_TTL_MS * 4 ? r : {}
}
