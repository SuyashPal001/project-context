import { z } from 'zod'

// Generated files used to be saved as "Generated Image.jpeg" (or Video/Song),
// so a Drive folder of a dozen results read as a dozen identical names. The
// generating agent already knows what each file shows; this lets it say so.
export const fileTitleSchema = z.string().max(120).optional()
  .describe('A short human name for the saved file, 2–6 words, the way a person would name it — e.g. "Maya at the bathroom vanity", "Iced coffee on oak table", "Upbeat lo-fi intro". No ids, no file extension. Always set it.')

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

/** A safe display name from the agent's title, or `fallback` when it gives nothing usable. */
export function fileTitle(title: string | undefined, fallback: string): string {
  const clean = (title ?? '')
    .replace(UUID, '')
    .replace(/\.[a-z0-9]{2,4}$/i, '')        // a stray extension; the uploader adds the real one
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ') // characters that break file names
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim()
  return clean || fallback
}

// The finished ad's name. The finishing steps (join, end card, captions, music,
// voice-over, tighten) only see file ids, so their output was named after the
// step: the delivered ad read "Beat with End Card.mp4" (2026-10-06). The
// Director already titles each clip with the product ("Avvatar Whey - Beat 1
// Video"); that prefix is remembered per conversation here and every finishing
// step names its output "<prefix> ad".
const AD_NAME_TTL_MS = 3 * 60 * 60 * 1000
const adNames = new Map<string, { base: string; at: number }>()

/** The product part of a clip title: "Avvatar Whey - Beat 1 Video" -> "Avvatar Whey". */
export function adBaseFromClipTitle(title: string | undefined): string | null {
  const clean = fileTitle(title, '')
  const base = clean
    .replace(/\s*[-–—:|·]?\s*\b(beat|scene|shot|clip|hook|part|panel)\b.*$/i, '')
    .replace(/\s*[-–—:|·]\s*$/, '')
    .trim()
  return base && base.toLowerCase() !== clean.toLowerCase() ? base : null
}

export function noteClipTitle(conversationId: string | undefined, title: string | undefined): void {
  const base = adBaseFromClipTitle(title)
  if (!conversationId || !base) return
  adNames.set(conversationId, { base, at: Date.now() })
  if (adNames.size > 5000) adNames.delete(adNames.keys().next().value as string)
}

/** "<product> ad" for this conversation's finishing steps, or `fallback` when no clip named one. */
export function finishedAdTitle(conversationId: string | undefined, fallback: string): string {
  const hit = conversationId ? adNames.get(conversationId) : undefined
  if (!hit || Date.now() - hit.at > AD_NAME_TTL_MS) return fallback
  return /\bad$/i.test(hit.base) ? hit.base : `${hit.base} ad`
}
