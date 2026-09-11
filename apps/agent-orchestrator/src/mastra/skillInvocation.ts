// "/" in chat turns a skill on for one conversation, the way Claude Code's
// /skill-name does: it never attaches the skill to the agent. See
// docs/superpowers/specs/2026-09-11-agent-skills-model-design.md.
//
// Pure on purpose: no database or Mastra runtime imports, so the merge and
// forcing rules are unit-testable without platformAgent's DB singletons.

export interface InvokedSkill {
  installId: string
  skillId: string
  /** The skill's display name, as stored on the conversation for chips. */
  name: string
}

/** A conversation keeps at most this many "/" skills, matching the per-agent cap. */
export const MAX_INVOKED_SKILLS = 8

/**
 * Adds this message's "/" picks to the conversation's invoked list.
 * `newlyInvoked` is what this message actually turned on — the skills whose
 * instructions this turn must load. A skill already on is not re-invoked, and
 * the cap keeps the existing skills and drops the newest extras.
 */
export function mergeInvokedSkills(
  existing: InvokedSkill[],
  added: InvokedSkill[],
): { merged: InvokedSkill[]; newlyInvoked: InvokedSkill[] } {
  const merged = [...existing]
  const newlyInvoked: InvokedSkill[] = []
  for (const skill of added) {
    if (merged.length >= MAX_INVOKED_SKILLS) break
    if (merged.some((s) => s.installId === skill.installId)) continue
    merged.push(skill)
    newlyInvoked.push(skill)
  }
  return { merged, newlyInvoked }
}
