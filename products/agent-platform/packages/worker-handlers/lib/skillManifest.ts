import YAML from 'yaml';

export class SkillManifestError extends Error {}

export interface SkillManifest {
  name: string;
  description: string;
  [key: string]: unknown;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

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

  return manifest as SkillManifest;
}

/** Everything after the frontmatter block — the actual authored SKILL.md body, for display. */
export function stripSkillManifestFrontmatter(skillMdContent: string): string {
  const match = FRONTMATTER_RE.exec(skillMdContent);
  return match ? match[2].trim() : skillMdContent.trim();
}
