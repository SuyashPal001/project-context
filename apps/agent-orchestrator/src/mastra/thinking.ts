// Dynamic thinking budget heuristic.
// Avoids paying full thinking cost for simple conversational messages.
//
// Budget tiers:
//   0     — conversational / acknowledgement (no reasoning needed)
//   1024  — general Q&A, task status, short lookups (default)
//   8192  — complex reasoning: planning, analysis, code, PRDs

const CONVERSATIONAL = new Set([
  'hi', 'hello', 'hey', 'thanks', 'thank you', 'ok', 'okay', 'got it',
  'sure', 'yes', 'no', 'great', 'nice', 'cool', 'good', 'bye', 'goodbye',
  'sounds good', 'perfect', 'alright', 'understood', 'noted',
])

const COMPLEX_KEYWORDS = [
  'analyze', 'analysis', 'plan', 'planning', 'prd', 'roadmap',
  'compare', 'comparison', 'evaluate', 'evaluation', 'architecture',
  'design', 'implement', 'implementation', 'code', 'debug', 'refactor',
  'strategy', 'breakdown', 'estimate', 'milestone', 'sprint',
  'write', 'draft', 'generate', 'create a', 'build a', 'explain how',
  'why does', 'how does', 'what is the difference', 'pros and cons',
]

export function getThinkingBudget(message: string): number {
  const lower = message.trim().toLowerCase()

  // Very short or purely conversational
  if (lower.length < 15 || CONVERSATIONAL.has(lower)) return 0

  // Complex reasoning keywords
  if (COMPLEX_KEYWORDS.some(kw => lower.includes(kw))) return 8192

  // Long messages likely need more reasoning
  if (message.length > 300) return 8192

  // Default: light thinking
  return 1024
}
