import YAML from 'yaml';

export class SkillManifestError extends Error {}

export interface SkillManifest {
  name: string;
  description: string;
  [key: string]: unknown;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// A non-empty description like "a skill" or "helper" passes a presence check
// but gives an agent's skill_search nothing to match a task against. This is
// the cheapest, least-ambiguous floor: a real "when to use this" sentence is
// essentially never under 20 characters.
const MIN_DESCRIPTION_LENGTH = 20;

/**
 * Parses SKILL.md's YAML frontmatter. Only `name` and `description` are
 * required — every other frontmatter key passes through into the stored
 * manifest jsonb untouched, since runtime wiring (what the agent does with
 * it) is out of scope for this pass.
 */
export function parseSkillManifest(skillMdContent: string): SkillManifest {
  const match = FRONTMATTER_RE.exec(skillMdContent);
  if (!match) {
    throw new SkillManifestError('SKILL.md must start with a --- YAML frontmatter block');
  }

  const [, frontmatter] = match;
  let parsed: unknown;
  try {
    parsed = YAML.parse(frontmatter);
  } catch (err) {
    throw new SkillManifestError(`SKILL.md frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SkillManifestError('SKILL.md frontmatter must be a YAML mapping');
  }

  const manifest = parsed as Record<string, unknown>;
  if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0) {
    throw new SkillManifestError("SKILL.md frontmatter is missing required field 'name'");
  }
  if (typeof manifest.description !== 'string' || manifest.description.trim().length === 0) {
    throw new SkillManifestError("SKILL.md frontmatter is missing required field 'description'");
  }
  if (manifest.description.trim().length < MIN_DESCRIPTION_LENGTH) {
    throw new SkillManifestError(
      `SKILL.md frontmatter 'description' is too short to be useful (${manifest.description.trim().length} chars, minimum ${MIN_DESCRIPTION_LENGTH}) — write a real sentence saying when an agent should use this skill`,
    );
  }
  // Weak but cheap proxy for "states when to use it" vs. "summarizes what it
  // does" — the two read differently to a human, but the only mechanical
  // signal available without an LLM pass is whether the sentence bothers to
  // say "when" at all. Mirrors the same floor in createSkill.ts.
  if (!/\bwhen\b/i.test(manifest.description)) {
    throw new SkillManifestError(
      `SKILL.md frontmatter 'description' should say when to use this skill, not just what it does — start with "Use when..." and name the trigger`,
    );
  }

  return manifest as SkillManifest;
}

/** Everything after the frontmatter block — the actual authored SKILL.md body, for display. */
export function stripSkillManifestFrontmatter(skillMdContent: string): string {
  const match = FRONTMATTER_RE.exec(skillMdContent);
  return match ? match[2].trim() : skillMdContent.trim();
}
