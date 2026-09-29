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
