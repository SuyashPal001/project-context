// Vertex refuses some prompts outright (2026-10-05: Omni on "high-school girl
// … spin"). The same prompt fails the same way on every path, so this is
// never a reason to fall back or to count a backend failure: it is a plain
// refusal the agent can act on by rephrasing. Shared by video.ts and music.ts.
export function isContentBlocked(message: string): boolean {
  return /content_blocked|Responsible AI/i.test(message)
}
