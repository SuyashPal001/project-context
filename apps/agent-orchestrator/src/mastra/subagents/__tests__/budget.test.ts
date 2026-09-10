import { describe, it, expect } from 'vitest'
import { checkDelegationBudget } from '../budget.js'
import { getSpec } from '../sources.js'

const director = getSpec('director')!   // estimatedCredits 20_000

describe('checkDelegationBudget', () => {
  it('allows when the balance covers the estimate', async () => {
    const check = async () => ({ allowed: true, balanceMicro: 50_000n, unlimited: false })
    expect(await checkDelegationBudget({ tenantId: 't1', spec: director }, { check })).toEqual({ allowed: true })
  })

  it('allows an unlimited tenant without reading a balance', async () => {
    const check = async () => ({ allowed: true, balanceMicro: 0n, unlimited: true })
    expect((await checkDelegationBudget({ tenantId: 't1', spec: director }, { check })).allowed).toBe(true)
  })

  it('refuses when the balance is below the estimate, with a reason naming the delegate', async () => {
    const check = async () => ({ allowed: true, balanceMicro: 1_000n, unlimited: false })
    const decision = await checkDelegationBudget({ tenantId: 't1', spec: director }, { check })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/director/)
    expect(decision.reason).toMatch(/credit/i)
  })

  it('refuses when the account is not allowed to spend at all', async () => {
    const check = async () => ({ allowed: false, balanceMicro: 0n, unlimited: false })
    expect((await checkDelegationBudget({ tenantId: 't1', spec: director }, { check })).allowed).toBe(false)
  })

  it('fails closed when the balance check throws', async () => {
    const check = async () => { throw new Error('pool down') }
    const decision = await checkDelegationBudget({ tenantId: 't1', spec: director }, { check })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/could not be checked/i)
  })

  it('refuses when there is no tenant to bill', async () => {
    const check = async () => { throw new Error('should not be called') }
    expect((await checkDelegationBudget({ tenantId: '', spec: director }, { check })).allowed).toBe(false)
  })
})
