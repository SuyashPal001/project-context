import { describe, it, expect, vi } from 'vitest'
vi.mock('./askClarifyingQuestions.js', () => ({ askClarifyingQuestionsTool: { execute: vi.fn() } }))
vi.mock('./checkClip.js', () => ({ checkClip: { execute: vi.fn() } }))
import { AD_FLOW_KEY, TVC_STEP_KEY, firstVoiceUnreviewed, isTvcAd, noteNarrationMade, noteTvcAd } from './reviewGate.js'
import { applyDelegationPromptFlags } from '../subagents/hooks.js'
import { reviewOutcome } from './reviewShots.js'

const mapCtx = (entries: Record<string, unknown>) => {
  const m = new Map<string, unknown>(Object.entries(entries))
  return { get: (k: string) => m.get(k), set: (k: string, v: unknown) => { m.set(k, v) } }
}

describe('R1: every narration block goes through in an animatic step', () => {
  it('the gate holds the second line normally, and lets it through while the step is the animatic', () => {
    const base = { conversationId: 'conv-anim', [AD_FLOW_KEY]: true, allowMode: 'ask' }
    noteNarrationMade('conv-anim')
    expect(firstVoiceUnreviewed(base)).toBe(true)
    expect(firstVoiceUnreviewed({ ...base, [TVC_STEP_KEY]: 'animatic' })).toBe(false)
  })
  it('the delegation prompt sets the step for "step: animatic" and "step: animatic change:", and clears it otherwise', () => {
    const ctx = mapCtx({ conversationId: 'conv-hook' })
    applyDelegationPromptFlags(ctx as never, 'flow: tvc ad\nTVC plan: p1\nstep: animatic')
    expect(ctx.get(TVC_STEP_KEY)).toBe('animatic')
    applyDelegationPromptFlags(ctx as never, 'flow: tvc ad\nTVC plan: p1\nstep: animatic change: shot 2 a bit longer')
    expect(ctx.get(TVC_STEP_KEY)).toBe('animatic')
    applyDelegationPromptFlags(ctx as never, 'flow: tvc ad\nTVC plan: p1\nstep: finish')
    expect(ctx.get(TVC_STEP_KEY)).toBeUndefined()
  })
  it('a tvc ad delegation marks the conversation as a TVC ad', () => {
    expect(isTvcAd('conv-tvc')).toBe(false)
    applyDelegationPromptFlags(mapCtx({ conversationId: 'conv-tvc' }) as never, 'flow: tvc ad\nstep: plan')
    expect(isTvcAd('conv-tvc')).toBe(true)
    noteTvcAd(undefined)
    expect(isTvcAd(undefined)).toBe(false)
  })
})

describe('R8: the stills review points a TVC ad in Ask mode at the rough cut', () => {
  const shot = [{ fileId: '11111111-1111-4111-8111-111111111111', label: 'Scene 1' }]
  const ok = { selectedLabel: 'Looks good — continue (Recommended)' }
  it('says step: animatic for a TVC ad in Ask mode', () => {
    expect(reviewOutcome('still', shot, ok, { tvcAsk: true }).nextStep).toBe('Continue: make the remaining stills, or if every still exists, the rough cut: delegate "step: animatic" to agent-director.')
  })
  it('is unchanged otherwise, and for clips and voice', () => {
    expect(reviewOutcome('still', shot, ok).nextStep).toBe('Continue: make the remaining stills, or if every still exists, the clips.')
    expect(reviewOutcome('clip', shot, ok, { tvcAsk: true }).nextStep).toBe('Continue: make the remaining clips, or if every clip exists, finish the ad.')
    expect(reviewOutcome('voice', shot, ok, { tvcAsk: true }).nextStep).toContain('ONE generate_narration')
  })
})
