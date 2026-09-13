// Shared validation for agent-authored SKILL.md drafts — used by both the
// draft/validate/retry loop (skillDraftWorkflow.ts) and save_skill's final
// safety check before it reaches the network (saveSkill.ts).
//
// This is a best-effort MIRROR of the server-side authority,
// parseSkillManifest in products/agent-platform/packages/worker-handlers/
// lib/skillManifest.ts — that package isn't importable from here (separate
// deployable, separate package.json), so the two are kept in sync by hand.
// A draft that passes here but fails there is a real possibility (regex vs.
// a real YAML.parse); the point of this copy is fast, cheap feedback inside
// the retry loop, not the final word.

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

const MAX_BODY_BYTES = 65_536
// Mirrors Anthropic's own "keep SKILL.md under 500 lines" guidance
// (platform.claude.com/docs/.../best-practices) — past this, content
// belongs in a reference file, which this system doesn't support yet
// (single-file only; multi-file/progressive-disclosure is a later phase).
const MAX_BODY_LINES = 500

// Mirrors MIN_DESCRIPTION_LENGTH in
// products/agent-platform/packages/worker-handlers/lib/skillManifest.ts.
const MIN_DESCRIPTION_LENGTH = 20
// Anthropic's own frontmatter limit for `description`.
const MAX_DESCRIPTION_LENGTH = 1024

// Anthropic's own frontmatter rules for `name`.
const MAX_NAME_LENGTH = 64
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const RESERVED_NAME_WORDS = ['anthropic', 'claude']

export interface SkillValidationResult {
  error: string | null
}

/**
 * Validates the frontmatter contract `parseSkillManifest` enforces in the
 * import worker, plus a few stricter authoring-quality checks Anthropic's
 * own Skill authoring guide recommends that the worker doesn't (yet) gate
 * on: kebab-case `name`, a `description` length ceiling and third-person
 * check, and a body line-count ceiling. Checked here so a malformed or
 * low-quality draft is a fast, cheap loop the draft workflow can fix on the
 * spot, rather than a full round-trip through the approval card or a
 * `failed` version row the user discovers minutes later on the Skills page.
 */
export function validateSkillBody(body: string, name: string): string | null {
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return `SKILL.md must be under ${MAX_BODY_BYTES} bytes`

  const lineCount = body.split(/\r?\n/).length
  if (lineCount > MAX_BODY_LINES) {
    return `SKILL.md body is ${lineCount} lines, over the ${MAX_BODY_LINES}-line cap — move reference material out or trim it (this system doesn't yet support multi-file skills)`
  }

  const match = FRONTMATTER_RE.exec(body)
  if (!match) return 'SKILL.md must start with a --- YAML frontmatter block'
  const frontmatter = match[1]

  const nameMatch = /^name:\s*(\S.*)$/m.exec(frontmatter)
  if (!nameMatch) return "SKILL.md frontmatter is missing required field 'name'"
  const frontmatterName = nameMatch[1].trim().replace(/^["']|["']$/g, '')
  if (frontmatterName.length > MAX_NAME_LENGTH) {
    return `SKILL.md frontmatter 'name' is too long (${frontmatterName.length} chars, maximum ${MAX_NAME_LENGTH})`
  }
  if (!NAME_RE.test(frontmatterName)) {
    return `SKILL.md frontmatter 'name' must be lowercase-kebab-case (letters, digits, single hyphens — e.g. "${name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'my-skill'}"), got "${frontmatterName}"`
  }
  if (RESERVED_NAME_WORDS.some((w) => frontmatterName.includes(w))) {
    return `SKILL.md frontmatter 'name' cannot contain a reserved word (${RESERVED_NAME_WORDS.join(', ')})`
  }

  const descriptionMatch = /^description:\s*(\S.*)$/m.exec(frontmatter)
  if (!descriptionMatch) return "SKILL.md frontmatter is missing required field 'description'"
  const description = descriptionMatch[1].trim()
  if (description.length < MIN_DESCRIPTION_LENGTH) {
    return `SKILL.md frontmatter 'description' is too short to be useful (${description.length} chars, minimum ${MIN_DESCRIPTION_LENGTH}) — write a real sentence saying when an agent should use this skill`
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return `SKILL.md frontmatter 'description' is too long (${description.length} chars, maximum ${MAX_DESCRIPTION_LENGTH})`
  }
  // Weak but cheap proxy for "states when to use it" vs. "summarizes what it
  // does" — the two read differently to a human, but the only mechanical
  // signal available without an LLM pass is whether the sentence bothers to
  // say "when" at all. Mirrors the same floor in skillManifest.ts.
  if (!/\bwhen\b/i.test(description)) {
    return `SKILL.md frontmatter 'description' should say when to use this skill, not just what it does — start with "Use when..." and name the trigger`
  }
  // Anthropic: "Always write in third person... inconsistent point-of-view
  // can cause discovery problems." A leading first/second-person opener is
  // the cheap, reliable signal — catches "I can help with..." and "You can
  // use this to..." without false-positiving on ordinary third-person prose
  // that happens to contain "you" or "I" mid-sentence.
  if (/^(I\b|I'll\b|I'm\b|You\b|You'll\b|Your\b)/i.test(description)) {
    return `SKILL.md frontmatter 'description' must be written in third person (e.g. "Generates..." / "Use when...", not "I can..." or "You can...")`
  }

  // allowed-tools is optional frontmatter (most skills need no extra
  // tools), so its absence is never an error — only a malformed value when
  // present. Format only; wiring the parsed list into agent_skills.tools
  // (currently always '{}', per skillImport.ts) is a separate change in the
  // worker-handlers package.
  const allowedToolsMatch = /^allowed-tools:\s*(.+)$/m.exec(frontmatter)
  if (allowedToolsMatch && allowedToolsMatch[1].trim().length === 0) {
    return "SKILL.md frontmatter 'allowed-tools' is present but empty — remove the field or list at least one tool"
  }

  return null
}

// UUID-like tokens (8-4-4-4-12 hex) are exact identifiers — asset IDs,
// install IDs, etc. — that must never be paraphrased, "corrected", or
// hallucinated. Observed in practice: skillDraftAgent.ts's explicit
// "preserve verbatim" instruction alone was not enough — a real draft
// transposed one digit in one ID and cross-contaminated a fragment of a
// different ID into another, despite the instruction. This is not an
// open-ended judgment call the model can be trusted with; it's a mechanical
// diff, so it's checked mechanically.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const URL_RE = /https?:\/\/\S+/g
// Trailing punctuation a URL is often followed by in prose ("...system.",
// "(see URL)") that a greedy \S+ match would otherwise swallow.
const TRAILING_PUNCT_RE = /[)\].,;:`]+$/

/**
 * Checks that every UUID-like identifier and URL in the brief survives
 * byte-identical in the draft. Only meaningful when the caller has the
 * original brief in scope (skillDraftWorkflow.ts) — save_skill's final
 * safety check has no brief to compare against, so this is not part of
 * validateSkillBody.
 */
export function validateVerbatimTokens(brief: string, draft: string): string | null {
  const uuids = new Set(brief.match(UUID_RE) ?? [])
  for (const uuid of uuids) {
    if (!draft.includes(uuid)) {
      return `An identifier from the brief is missing or altered in the draft: "${uuid}" does not appear byte-for-byte. Do not paraphrase, retype, or "correct" any ID, URL, hex color, or other exact value from the brief — copy it character-for-character.`
    }
  }

  const urls = new Set(
    Array.from(brief.match(URL_RE) ?? [], (u) => u.replace(TRAILING_PUNCT_RE, '')).filter(Boolean),
  )
  for (const url of urls) {
    if (!draft.includes(url)) {
      return `A URL from the brief is missing or altered in the draft: "${url}" does not appear byte-for-byte. Copy every URL character-for-character.`
    }
  }

  return null
}
