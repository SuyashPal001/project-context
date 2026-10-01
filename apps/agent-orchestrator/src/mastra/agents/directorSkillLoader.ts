// Director's half of an Official skill (its director.md, e.g. the TVC
// character rules) is a native Mastra skill on Director — see usage.ts's
// fetchOfficialDirectorSkills. Mastra lists skills by name and description
// and leaves loading to the model, which can skip it. These rules decide the
// whole look of the output, so a skipped load is never acceptable: when
// Olmo's brief carries a skill's marker ("style: tvc"), this processor forces
// the first step of the run to call Mastra's own `skill` tool, the same way
// chatStream.ts's prepareStep forces Olmo to load a "/" skill.

import type { Processor, ProcessInputStepArgs, ProcessInputStepResult } from '@mastra/core/processors'
import { fetchOfficialDirectorSkills, type OfficialDirectorSkill } from '../../usage.js'

type MessageLike = { role?: string; content?: unknown }

function messageText(message: MessageLike): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!content || typeof content !== 'object') return ''
  const c = content as { content?: unknown; parts?: unknown }
  if (Array.isArray(c.parts)) {
    return c.parts
      .map((p) => (p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : ''))
      .join('\n')
  }
  return typeof c.content === 'string' ? c.content : ''
}

/** The text of the latest user message — Olmo's brief, on a delegated run. */
export function latestUserText(messages: MessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messageText(messages[i])
  }
  return ''
}

/** The Director skills whose marker appears in the brief, case-insensitive. */
export function matchDirectorSkills(brief: string, skills: OfficialDirectorSkill[]): OfficialDirectorSkill[] {
  const text = brief.toLowerCase()
  return skills.filter((s) => text.includes(s.marker.toLowerCase()))
}

export function directorSkillInstruction(matched: OfficialDirectorSkill[]): string {
  const names = matched.map((s) => s.skill.name).join(', ')
  return `This brief is a ${names} job. Activate ${names} with the skill tool now, using exactly that name, and follow it for every prompt you write in this run.`
}

export class DirectorSkillLoader implements Processor<'director-skill-loader'> {
  readonly id = 'director-skill-loader' as const
  readonly name = 'Director skill loader'

  constructor(private readonly load: () => Promise<OfficialDirectorSkill[]> = fetchOfficialDirectorSkills) {}

  async processInputStep({ stepNumber, messages, messageList, tools }: ProcessInputStepArgs): Promise<ProcessInputStepResult | undefined> {
    if (stepNumber !== 0) return undefined
    const matched = matchDirectorSkills(latestUserText(messages as MessageLike[]), await this.load())
    if (matched.length === 0) return undefined
    if (!tools || !('skill' in tools)) {
      console.warn('[director-skill-loader] brief matched', matched.map((s) => s.skill.name).join(', '), 'but no skill tool is available')
      return undefined
    }
    messageList.addSystem({ role: 'system', content: directorSkillInstruction(matched) })
    return { toolChoice: { type: 'tool', toolName: 'skill' } }
  }
}
