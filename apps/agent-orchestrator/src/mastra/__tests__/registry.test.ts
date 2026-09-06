import { describe, it, expect, vi } from 'vitest'

const platformAgentStub = vi.hoisted(() => ({ id: 'platform-stub' }))
const pmAgentStub = vi.hoisted(() => ({ id: 'pm-stub' }))
const architectAgentStub = vi.hoisted(() => ({ id: 'architect-stub' }))
const directorAgentStub = vi.hoisted(() => ({ id: 'director-stub' }))

vi.mock('../agents/platformAgent.js', () => ({ platformAgent: platformAgentStub }))
vi.mock('../agents/pmAgent.js', () => ({ pmAgent: pmAgentStub }))
vi.mock('../agents/architectAgent.js', () => ({ architectAgent: architectAgentStub }))
vi.mock('../agents/directorAgent.js', () => ({ directorAgent: directorAgentStub }))

import { resolveAgent, resolveAgentLabel } from '../registry.js'

describe('registry — director', () => {
  it('resolves the exact agent name "Director" (lowercased) to directorAgent', () => {
    expect(resolveAgent('Director')).toBe(directorAgentStub)
  })

  it('labels directorAgent correctly', () => {
    expect(resolveAgentLabel(directorAgentStub as never)).toBe('directorAgent')
  })
})

describe('registry — olmo', () => {
  it('resolves the exact agent name "Olmo" (lowercased) to platformAgent', () => {
    expect(resolveAgent('Olmo')).toBe(platformAgentStub)
  })

  it('labels platformAgent (Olmo) correctly', () => {
    expect(resolveAgentLabel(platformAgentStub as never)).toBe('platformAgent')
  })
})
