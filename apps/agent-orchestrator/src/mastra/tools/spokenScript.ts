// A "continue" video is the whole video so far: the earlier parts' picture and
// sound are kept as they were (measured 2026-10-05, under 0.5dB apart) and the
// new part is added at the end. check_clip hears every line in it, so it is
// checked against the full script, not only the new part's line.

const MAX_ENTRIES = 2000
const byInteraction = new Map<string, string[]>()
const byFile = new Map<string, string[]>()

function remember(map: Map<string, string[]>, key: string, value: string[]): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string)
}

export function recordSpoken(conversationId: string, v: { continueFrom?: string; approvedDialogue?: string; interactionId?: string; fileId?: string }): void {
  const before = v.continueFrom ? byInteraction.get(`${conversationId}:${v.continueFrom}`) ?? [] : []
  const full = [...before, v.approvedDialogue?.trim() ?? ''].filter(Boolean)
  if (!full.length) return
  if (v.interactionId) remember(byInteraction, `${conversationId}:${v.interactionId}`, full)
  if (v.fileId) remember(byFile, `${conversationId}:${v.fileId}`, full)
}

/** Every line spoken in this clip, in order (earlier parts' lines first); undefined when unknown. */
export function spokenSoFar(conversationId: string, fileId: string): string[] | undefined {
  return byFile.get(`${conversationId}:${fileId}`)
}

/** A line written as the middle of a sentence ("...it actually tastes") makes
 * Omni invent a lead-in word ("No, it actually tastes", 2026-10-05 wafer run).
 * Leading dots are dropped from the spoken line. */
export function cleanSpokenStart(line: string): string {
  return line.replace(/^\s*(?:\.{2,}|…)\s*/, '')
}
