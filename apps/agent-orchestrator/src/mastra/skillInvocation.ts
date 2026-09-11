// "/" in chat turns a skill on for one conversation, the way Claude Code's
// /skill-name does: it never attaches the skill to the agent. See
// docs/superpowers/specs/2026-09-11-agent-skills-model-design.md.
//
// Pure on purpose: no database or Mastra runtime imports, so the merge and
// forcing rules are unit-testable without platformAgent's DB singletons.
// The one exception is `ProcessInputStepArgs` below, a type-only import from
// @mastra/core/processors — it adds no runtime dependency.

import type { ProcessInputStepArgs } from '@mastra/core/processors'

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

/**
 * On the turn skills are invoked, force the first `count` steps to call
 * Mastra's own `skill` tool, so their instructions are loaded before the
 * agent answers — the native equivalent of Claude Code's /skill-name. After
 * that turn nothing is forced: the loaded instructions stay in the
 * conversation as tool results, and the skills stay in the resolver's set
 * so the agent can call `skill` again if they fall out of context.
 *
 * The parameter is typed as `ProcessInputStepArgs` (Mastra's real
 * `PrepareStepFunction` argument, from @mastra/core/processors) rather than
 * the narrower `{ stepNumber: number }` shape this function actually reads,
 * so the returned function satisfies `prepareStep` at the `stream()` call
 * site in chatStream.ts without a cast there.
 */
export function buildSkillInvocationPrepareStep(
  count: number,
): ((args: ProcessInputStepArgs) => { toolChoice: { type: 'tool'; toolName: 'skill' } } | undefined) | undefined {
  if (count <= 0) return undefined
  return ({ stepNumber }) => (stepNumber < count ? { toolChoice: { type: 'tool', toolName: 'skill' } } : undefined)
}

/**
 * One sentence naming this turn's invoked skills, so the forced `skill` calls
 * load the right ones.
 *
 * `Array.isArray` guard: `names` is typed as string[], but Mastra Studio's
 * Chat tab synthesizes its own request context from tenantContextSchema
 * instead of going through chatStream.ts (which always sets a real array),
 * and its default for an optional array field is not itself an array —
 * calling .join() on that crashed Studio's agent loader with "names.join is
 * not a function". Treat anything non-array as no skills invoked.
 */
export function invokedSkillsInstruction(names: string[]): string {
  if (!Array.isArray(names) || names.length === 0) return ''
  return `\n\n## Skills the user turned on\nThe user turned on these skills with "/" in this message: ${names.join(', ')}. Activate each one with the skill tool, using exactly these names, before you answer.`
}

/** Attached skills first; a skill that is both attached and invoked appears once. */
export function mergeSkillSets<T extends { name: string }>(attached: T[], invoked: T[]): T[] {
  const byName = new Map<string, T>()
  for (const skill of [...attached, ...invoked]) if (!byName.has(skill.name)) byName.set(skill.name, skill)
  return [...byName.values()]
}
