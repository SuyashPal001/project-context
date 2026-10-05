// Lyria 3 returns its lyrics as text parts with one timed line each, e.g.
// "[9.4:14.9] Chai Nation, mazaa baar baar" (spec 2026-10-05-tvc-jingle-
// design.md J2). The sign-off is found here in code, so the cut never
// depends on Director reading timestamps.
export interface TimedLine { start: number; end: number; text: string }

const LINE_RE = /^\s*\[\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*\]\s*(.*?)\s*$/
export const MIN_LINE_OVERLAP = 0.8

export function parseTimedLyrics(text: string): TimedLine[] {
  const out: TimedLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(raw)
    if (!m) continue
    const start = Number(m[1]), end = Number(m[2]), line = m[3]
    if (!(end > start) || !line) continue
    out.push({ start, end, text: line })
  }
  return out
}

/** Lowercase words with punctuation removed. Keeps letters, combining marks
 *  (Devanagari vowel signs, nukta) and digits; NFC so ज़ matches ज + ◌़. */
export function lyricWords(s: string): string[] {
  return s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
}

/** The share of the wanted words that appear in the candidate line (0..1). */
export function lineOverlap(wanted: string, candidate: string): number {
  const want = lyricWords(wanted)
  if (want.length === 0) return 0
  const have = new Set(lyricWords(candidate))
  return want.filter((w) => have.has(w)).length / want.length
}

/** The sung line that best matches the sign-off (overlap ≥ 0.8), or null.
 *  On a tie the later line wins: a repeated sign-off resolves at the end. */
export function findLine(lines: TimedLine[], wanted: string): TimedLine | null {
  let best: TimedLine | null = null
  let bestScore = 0
  for (const l of lines) {
    const score = lineOverlap(wanted, l.text)
    if (score >= MIN_LINE_OVERLAP && score >= bestScore) { best = l; bestScore = score }
  }
  return best
}
