import { checkCreditBalance } from '../../credits.js'
import type { SubAgentSpec } from './spec.js'

export interface BudgetDecision {
  allowed: boolean
  /** Shown to the parent model as rejectionReason, so it can wrap up honestly. */
  reason?: string
}

export interface BudgetDeps {
  check?: typeof checkCreditBalance
}

/**
 * Per-delegation spend gate. Mastra's maxSteps and a goal's maxRuns count
 * STEPS — fifty steps of text and fifty steps of video generation look the
 * same to them — so money is checked here, separately, before the delegation
 * runs.
 *
 * The estimate is static (SubAgentSpec.estimatedCredits), so this is a
 * pre-check, not a reservation: a delegate that generates three videos when
 * its spec said one overruns and is caught on the NEXT delegation. Reserving
 * properly means charge-then-settle, which chargeTaskEstimate/settleTask
 * already do for tasks — an argument for routing expensive work through
 * tasks, not for a second reservation system here.
 *
 * Fails closed, matching checkCreditBalance.
 */
export async function checkDelegationBudget(
  args: { tenantId: string; spec: SubAgentSpec },
  deps: BudgetDeps = {},
): Promise<BudgetDecision> {
  const { tenantId, spec } = args
  if (!tenantId) {
    return { allowed: false, reason: `Delegation to "${spec.id}" refused: no tenant to bill.` }
  }
  const check = deps.check ?? checkCreditBalance
  try {
    const balance = await check(tenantId)
    if (balance.unlimited) return { allowed: true }
    if (!balance.allowed) {
      return { allowed: false, reason: `Delegation to "${spec.id}" refused: this workspace is out of credits.` }
    }
    if (balance.balanceMicro < BigInt(Math.ceil(spec.estimatedCredits))) {
      return {
        allowed: false,
        reason: `Delegation to "${spec.id}" refused: it needs about ${spec.estimatedCredits} micro-credits and the workspace has ${balance.balanceMicro}. Finish with what you already have, and tell the user credits ran out.`,
      }
    }
    return { allowed: true }
  } catch (err) {
    console.error(`[subagents] budget check failed tenantId=${tenantId} spec=${spec.id}:`, (err as Error).message)
    return { allowed: false, reason: `Delegation to "${spec.id}" refused: credits could not be checked.` }
  }
}
