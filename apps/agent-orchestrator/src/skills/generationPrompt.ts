// The prompt is the whole quality bar for created skills, and it is also the
// only thing standing between a user's brief and a version row that fails on
// SKILL.md frontmatter two services away. Both concerns live here so they can
// be tested without a model call.

export interface SkillBrief {
  name: string
  description?: string
  brief: string
  previousDraft?: string
  feedback?: string
}

export const SKILL_SYSTEM_PROMPT = `You write SKILL.md files. A skill is a page in a manual that an AI agent reads before doing a task — it is not documentation for a human, and not marketing copy.

Output rules, all mandatory:

1. Output the file and nothing else. No code fences, no preamble, no closing remarks.
2. Begin with a YAML frontmatter block, delimited by a line containing exactly --- before and after it. The block must contain:
   name: a lowercase kebab-case identifier, 2-4 words
   description: one sentence, under 200 characters, saying when an agent should use this skill
3. After the closing ---, write the body in Markdown.

Write the body as instructions addressed to the agent that will follow them:

- Lead with when the skill applies and when it does not.
- Give concrete steps, rules, and worked examples in the user's own domain vocabulary.
- Prefer specifics over generalities: exact phrasings, exact formats, exact thresholds. "Open with the client's name and the tender reference" beats "personalize the opening".
- State what to avoid, and why, where getting it wrong is likely.
- Keep it under roughly 400 lines. A skill an agent can hold in context beats an exhaustive one it skims.

Never invent facts about the user's business, customers, or numbers. Where a specific the agent needs is unknown, tell the agent to ask for it rather than filling it in.`

export function buildSkillPrompt(input: SkillBrief): string {
  const { name, description, brief, previousDraft, feedback } = input

  const sections = [
    `Skill name the user gave: ${name}`,
    description ? `One-line description the user gave: ${description}` : null,
    `What the user wants this skill to do:\n${brief}`,
  ].filter(Boolean)

  if (previousDraft) {
    sections.push(
      `Here is the previous draft you produced. Rewrite it in full — output the complete new file, not a diff or a description of changes.\n\n${previousDraft}`,
    )
    sections.push(
      feedback
        ? `What the user wants changed about that previous draft:\n${feedback}`
        : 'The user asked for another attempt without saying what was wrong. Produce a materially different draft rather than a reworded copy of the previous one.',
    )
  }

  return sections.join('\n\n')
}
