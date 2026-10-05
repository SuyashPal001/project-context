// A "continue" video is the whole video so far, and Omni re-renders part of the
// earlier speech when it continues (2026-10-05, vitamin C run: part 3's audio
// matched part 2 only for the first 2s). check_clip was given only the new
// part's line, so a changed earlier word would pass. generate_video records
// every line spoken so far against the file it returns, and check_clip checks
// the full script of a continued clip.

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

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean)

/** Words of already-approved earlier lines that the continued clip no longer
 * says. 2026-10-05: part 1 said "bright", the continued part re-voiced it as
 * "brining", and a whole-script score (1 word of 30 missing) still passed.
 * Only real words (4+ letters, not numbers) count, so a misheard "a" or "10"
 * does not fail a clip. */
export function changedEarlierWords(earlierLines: string[], heard: string): string[] {
  const got = new Set(words(heard))
  return [...new Set(earlierLines.flatMap(words))].filter((w) => w.length >= 4 && !/\d/.test(w) && !got.has(w))
}

/** A line written as the middle of a sentence ("...it actually tastes") makes
 * Omni invent a lead-in word ("No, it actually tastes", 2026-10-05 wafer run).
 * Leading dots are dropped from the spoken line. */
export function cleanSpokenStart(line: string): string {
  return line.replace(/^\s*(?:\.{2,}|…)\s*/, '')
}
