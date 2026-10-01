import { describe, it, expect, vi } from 'vitest'
import { createSkill } from '@mastra/core/skills'

vi.mock('../../../usage.js', () => ({ fetchOfficialDirectorSkills: vi.fn(async () => []) }))

import { DirectorSkillLoader, latestUserText, matchDirectorSkills } from '../directorSkillLoader.js'

const tvc = {
  marker: 'style: tvc',
  skill: createSkill({ name: 'tvc-character-creator', description: 'TVC rules', instructions: 'TVC Director rules.' }),
}

const userMessage = (text: string) => ({ role: 'user', content: { format: 2, parts: [{ type: 'text', text }] } })

function stepArgs(stepNumber: number, brief: string, tools: Record<string, unknown> = { skill: {}, generate_images: {} }) {
  const addSystem = vi.fn()
  return {
    addSystem,
    args: { stepNumber, messages: [userMessage('earlier message'), { role: 'assistant', content: 'ok' }, userMessage(brief)], messageList: { addSystem }, tools } as never,
  }
}

describe('DirectorSkillLoader', () => {
  it('forces the skill tool on the first step when the brief carries "style: tvc"', async () => {
    const loader = new DirectorSkillLoader(async () => [tvc])
    const { args, addSystem } = stepArgs(0, 'style: tvc, for a skincare brand, warm vibe, aspectRatio "3:4"')
    await expect(loader.processInputStep(args)).resolves.toEqual({ toolChoice: { type: 'tool', toolName: 'skill' } })
    expect(addSystem).toHaveBeenCalledWith({ role: 'system', content: expect.stringContaining('Activate tvc-character-creator with the skill tool now') })
  })

  it('forces nothing after the first step, so the run is free once the rules are loaded', async () => {
    const loader = new DirectorSkillLoader(async () => [tvc])
    const { args, addSystem } = stepArgs(1, 'style: tvc')
    await expect(loader.processInputStep(args)).resolves.toBeUndefined()
    expect(addSystem).not.toHaveBeenCalled()
  })

  it('forces nothing for a brief from another skill', async () => {
    const loader = new DirectorSkillLoader(async () => [tvc])
    const { args } = stepArgs(0, 'style: claymation, a baker mascot')
    await expect(loader.processInputStep(args)).resolves.toBeUndefined()
  })

  it('never forces a skill tool that does not exist', async () => {
    const loader = new DirectorSkillLoader(async () => [tvc])
    const { args } = stepArgs(0, 'style: tvc', { generate_images: {} })
    await expect(loader.processInputStep(args)).resolves.toBeUndefined()
  })
})

describe('latestUserText / matchDirectorSkills', () => {
  it('reads the latest user message, from parts or a plain string', () => {
    expect(latestUserText([userMessage('first'), { role: 'user', content: 'Style: TVC brief' }])).toBe('Style: TVC brief')
    expect(latestUserText([{ role: 'assistant', content: 'hi' }])).toBe('')
  })

  it('matches the marker case-insensitively', () => {
    expect(matchDirectorSkills('Style: TVC, beauty', [tvc])).toHaveLength(1)
    expect(matchDirectorSkills('style: cinematic anime', [tvc])).toHaveLength(0)
  })
})
