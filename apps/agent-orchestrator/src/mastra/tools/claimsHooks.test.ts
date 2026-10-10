import { describe, it, expect } from 'vitest'
import { applyDelegationPromptFlags } from '../subagents/hooks.js'
import { TVC_CLAIM_ANSWERS_KEY } from './claims.js'

const ctx = () => {
  const m = new Map<string, unknown>()
  return { m, c: { set: (k: never, v: never) => { m.set(k as string, v) }, get: (k: never) => m.get(k as string) } }
}

describe('D9: Claims: lines reach plan_tvc', () => {
  it('sets the answer keys from Olmo\'s delegation', () => {
    const { m, c } = ctx()
    applyDelegationPromptFlags(c, 'flow: tvc ad\nstep: plan\nTVC plan: abc\nClaims: "India’s No.1 fizz" = proof: Nielsen 2026')
    expect(m.get(TVC_CLAIM_ANSWERS_KEY)).toEqual([{ key: "india's no.1 fizz", answer: 'proof', proof: 'Nielsen 2026' }])
  })
  it('clears them on a delegation with none, so a later step never inherits them', () => {
    const { m, c } = ctx()
    applyDelegationPromptFlags(c, 'flow: tvc ad\nstep: plan\nClaims: "Zero sugar" = no_proof')
    applyDelegationPromptFlags(c, 'flow: tvc ad\nstep: stills')
    expect(m.get(TVC_CLAIM_ANSWERS_KEY)).toBeUndefined()
  })
})
