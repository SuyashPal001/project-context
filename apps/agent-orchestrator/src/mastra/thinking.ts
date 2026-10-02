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

// Approval-shaped short replies — see COST_CONFIRMATION_CONTRACT in
// platformAgent.ts, which explicitly treats these words as a valid approval
// of a just-proposed media-generation plan and requires the model's very
// next action to be a delegate call. Recognizing "the prior turn proposed a
// plan, this message affirms it, therefore delegate now" is a multi-step
// inference that needs real reasoning room — and it lands exactly on the
// shortest, most conversational-looking messages this file's zero-budget
// fast path exists to catch. Checked before that fast path so these never
// get budget=0. Confirmed live 2026-09-17: "approve" (7 chars, and also in
// CONVERSATIONAL via "yes"-shaped overlap) hit budget=0, and with zero
// reasoning tokens the model shortcut straight to the prompt's own
// honest-failure fallback text instead of executing the delegation
// imperative — even though message history correctly showed the pending
// plan (e4bf557d fixed that half; this is the other half).
const APPROVAL_SIGNALS = new Set([
  'yes', 'go', 'approve', 'approved', 'ok', 'okay', 'sure', 'looks good',
  'perfect', 'alright', 'sounds good', 'go ahead', "let's go", 'do it',
  'proceed', 'confirmed', 'confirm',
  // Everyday ways people say yes in chat, including the ones the user
  // listed 2026-10-02 ("all", "fine", "lets go") and Hinglish replies.
  'all', 'all of them', 'all good', 'all set', 'fine', 'lets go', "let's do it", 'lets do it',
  'yeah', 'yep', 'yup', 'ya', 'k', 'kk', 'yes please', 'good to go', 'ok go', 'okay go',
  'sounds great', 'works', 'works for me', 'done', 'agreed', 'accept', 'accepted',
  'haan', 'ha', 'theek hai', 'thik hai', 'chalo', 'kar do', 'karo',
  // Retry-shaped follow-ups after a failed generation. Same reason as the
  // approval words above — if these hit the <15-char fast path they land at
  // budget=0, olmoDelegates returns {}, and Olmo can't call agent-director /
  // agent-producer to actually re-fire the generation.
  'retry', 'try again', 'resend', 'regenerate', 'redo', 'again', 'once more',
  // Bare imperatives that ALSO mean "fire the pending plan". Same fast-path
  // trap. First-word matching below catches "generate it", "make it now",
  // "build the ad", etc.
  'generate', 'make', 'build', 'create', 'produce', 'run', 'start', 'do',
  'ship', 'send', 'submit', 'fire', 'kick off', 'kickoff',
])

const COMPLEX_KEYWORDS = [
  'analyze', 'analysis', 'plan', 'planning', 'prd', 'roadmap',
  'compare', 'comparison', 'evaluate', 'evaluation', 'architecture',
  'design', 'implement', 'implementation', 'code', 'debug', 'refactor',
  'strategy', 'breakdown', 'estimate', 'milestone', 'sprint',
  'write', 'draft', 'generate', 'create a', 'build a', 'explain how',
  'why does', 'how does', 'what is the difference', 'pros and cons',
]

// One-word approval signals long enough that a single typo can't land on an
// ordinary word ("no" is one edit from "do", "go" and "ok" — so short words
// never match loosely).
const TYPO_TOLERANT_SIGNALS = [...APPROVAL_SIGNALS].filter((w) => w.length >= 5 && !w.includes(' '))

/** Optimal string alignment distance capped at 1: true when a and b differ by
 *  one insertion, deletion, substitution or swap of two neighbouring letters. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (a.slice(i + 1) === b.slice(i + 1)) return true // substitution
  if (a.slice(i + 1) === b.slice(i)) return true // extra letter in a
  if (a.slice(i) === b.slice(i + 1)) return true // extra letter in b
  return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2) // swap
}

// A typo'd approval ("apprve", "aprove", "retyr") is still an approval.
// Live 2026-10-02: "apprve" fell to the <15-char fast path, budget=0 hid
// agent-director, and the model's delegate call ran nowhere.
const isTypoedApproval = (word: string) => word.length >= 4 && TYPO_TOLERANT_SIGNALS.some((s) => withinOneEdit(word, s))

export function getThinkingBudget(message: string): number {
  const raw = message.trim().toLowerCase()
  // A bare "?" or "??" is the user asking what happened, usually right after
  // a plan or a failed step — it needs the delegates in reach, not budget 0.
  if (/^[?!.\s]+$/.test(raw) && raw.includes('?')) return 1024
  // "approve!", "yes.", "ok 👍" match the same as the bare word.
  const lower = raw.replace(/[^\p{L}\p{N}'\s]+/gu, ' ').replace(/\s+/g, ' ').trim()

  // Approval-shaped replies always get at least default thinking, even
  // though several of these words also appear in CONVERSATIONAL below.
  // Match on first-word too — "yes create", "approve and go", "try again with X"
  // all read as approvals and must reach the delegate map.
  if (APPROVAL_SIGNALS.has(lower)) return 1024
  const firstWord = lower.split(/\s+/)[0] ?? ''
  const firstTwoWords = lower.split(/\s+/).slice(0, 2).join(' ')
  if (APPROVAL_SIGNALS.has(firstWord) || APPROVAL_SIGNALS.has(firstTwoWords)) return 1024
  if (isTypoedApproval(firstWord)) return 1024

  // Very short or purely conversational
  if (lower.length < 15 || CONVERSATIONAL.has(lower)) return 0

  // Complex reasoning keywords
  if (COMPLEX_KEYWORDS.some(kw => lower.includes(kw))) return 8192

  // Long messages likely need more reasoning
  if (message.length > 300) return 8192

  // Default: light thinking
  return 1024
}
