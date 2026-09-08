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

// Shared across both skill-creation paths: the web modal's Generate flow
// (SKILL_SYSTEM_PROMPT, below) and the in-chat create_skill flow
// (SKILL_CREATION_CONTRACT, in platformAgent.ts). Extracted so the two paths
// can never silently drift apart on what "good" skill content means — a
// change here reaches both.
export const SKILL_CONTENT_QUALITY_BAR = `- Lead with when the skill applies and when it does not.
- Give concrete steps, rules, and worked examples in the user's own domain vocabulary.
- Prefer specifics over generalities: exact phrasings, exact formats, exact thresholds, exact numbers. "Open with the client's name and the tender reference" beats "personalize the opening". If the brief is thin, do not pad with generic advice — pull in the real, well-known concrete standards of that domain (actual character limits, actual naming conventions, actual industry rules of thumb) rather than writing something that would apply to any task in any field.
- Where the domain has numeric constraints (limits, sizes, thresholds, formats), render them as a table, not prose.
- Include at least one concrete good-vs-bad example pair using realistic strings from the domain — not abstract descriptions of what makes something good.
- Include an explicit list of common mistakes or failure modes to avoid, and why each one fails.
- If the skill produces an artifact (a document, a message, a piece of copy, a config), include a literal output template or skeleton the agent fills in — not just a description of what the output should contain.
- State what to avoid, and why, where getting it wrong is likely.
- Keep it under roughly 400 lines. A skill an agent can hold in context beats an exhaustive one it skims.

Do not write steps whose content is "ask the user clarifying questions." A skill is consulted mid-task, not a conversation opener — the agent already has whatever context it has, and stopping to interview the user on every field defeats the point of having a skill. If a genuinely unknown, task-specific fact is required (a name, a number, a file that must exist), name that single fact plainly as a precondition near the top, not as a multi-step intake script.`

export const SKILL_SYSTEM_PROMPT = `You write SKILL.md files. A skill is a page in a manual that an AI agent reads before doing a task — it is not documentation for a human, and not marketing copy.

Output rules, all mandatory:

1. Output the file and nothing else. No code fences, no preamble, no closing remarks.
2. Begin with a YAML frontmatter block, delimited by a line containing exactly --- before and after it. The block must contain:
   name: a lowercase kebab-case identifier, 2-4 words
   description: one sentence, under 200 characters, saying when an agent should use this skill
3. After the closing ---, write the body in Markdown.

Write the body as instructions addressed to the agent that will follow them, not as advice addressed to a human:

${SKILL_CONTENT_QUALITY_BAR}

Never invent facts about the user's business, customers, or numbers. Where a specific fact the agent needs is unknown, say so as a precondition rather than filling it in or building the whole skill around asking for it.`

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
