// A "continue" video is the whole video so far, and Omni re-renders part of the
// earlier speech when it continues (2026-10-05, vitamin C run: part 3's audio
// matched part 2 only for the first 2s). check_clip was given only the new
// part's line, so a changed earlier word would pass. generate_video records
// every line spoken so far against the file it returns, and check_clip checks
// the full script of a continued clip.

const MAX_ENTRIES = 2000
const byInteraction = new Map<string, string>()
const byFile = new Map<string, string>()

function remember(map: Map<string, string>, key: string, value: string): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string)
}

export function recordSpoken(conversationId: string, v: { continueFrom?: string; approvedDialogue?: string; interactionId?: string; fileId?: string }): void {
  const before = v.continueFrom ? byInteraction.get(`${conversationId}:${v.continueFrom}`) ?? '' : ''
  const full = [before, v.approvedDialogue ?? ''].map((s) => s.trim()).filter(Boolean).join(' ')
  if (!full) return
  if (v.interactionId) remember(byInteraction, `${conversationId}:${v.interactionId}`, full)
  if (v.fileId) remember(byFile, `${conversationId}:${v.fileId}`, full)
}

/** Every line spoken in this clip, when it continued an earlier one; else undefined. */
export function spokenSoFar(conversationId: string, fileId: string): string | undefined {
  return byFile.get(`${conversationId}:${fileId}`)
}

/** A line written as the middle of a sentence ("...it actually tastes") makes
 * Omni invent a lead-in word ("No, it actually tastes", 2026-10-05 wafer run).
 * Leading dots are dropped from the spoken line. */
export function cleanSpokenStart(line: string): string {
  return line.replace(/^\s*(?:\.{2,}|…)\s*/, '')
}
