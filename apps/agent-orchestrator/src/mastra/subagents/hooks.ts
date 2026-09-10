import type {
  DelegationConfig, DelegationCompleteContext, DelegationStartContext,
} from '@mastra/core/agent'
import { getSpec } from './sources.js'
import { checkDelegationBudget } from './budget.js'
import { recordDelegation } from './link.js'

export interface HookDeps {
  budget?: typeof checkDelegationBudget
  record?: typeof recordDelegation
}

/**
 * The stable per-stream facts `onDelegationComplete` needs but cannot read
 * off its own context.
 *
 * @mastra/core 1.64's `DelegationCompleteContext` (agent.types.d.ts) carries
 * no `requestContext` field the way `DelegationStartContext` does, so there
 * is nowhere on that hook's own argument to read tenantId/conversationId/
 * agentId from. These three are constant for the whole stream() call this
 * config is attached to (chatStream.ts's SSE path, or the WebSocket path in
 * index.ts), so the call site supplies them once here instead of the hook
 * reaching for a context field that does not exist.
 */
export interface DelegationHost {
  tenantId: string
  conversationId: string | null
  agentId: string | null
}

/**
 * The delegation lifecycle for the Olmo path.
 *
 * NOTE: `delegation` is a per-EXECUTION option, not an Agent constructor
 * field, so this config has to be passed at every stream() call site that can
 * reach Olmo. There are two — routes/chatStream.ts (SSE) and index.ts
 * (WebSocket) — and a hook wired into only one of them silently does not run
 * on the other path.
 */
export function buildDelegationConfig(host: DelegationHost, deps: HookDeps = {}): DelegationConfig {
  const budget = deps.budget ?? checkDelegationBudget
  const record = deps.record ?? recordDelegation

  return {
    // If a hook throws, fail the delegation. The default ('warn') proceeds
    // with the original prompt and result — which for a credit hook means
    // work done and nobody billed, silently. Hook throws are also recorded on
    // the run context under __mastra_delegationHookErrors.
    hookErrorStrategy: 'throw',

    onDelegationStart: async (context: DelegationStartContext) => {
      const ctx = context.requestContext
      const spec = getSpec(context.primitiveId)
      const tenantId = (ctx.get('tenantId') as string | undefined) ?? ''

      if (!spec) {
        // resolveDelegates cannot return an unregistered delegate, so this is
        // a registry bug rather than a routing one — refuse loudly.
        return { proceed: false, rejectionReason: `"${context.primitiveId}" is not a registered sub-agent.` }
      }

      // 1. Money first: refuse before anything is spent.
      const decision = await budget({ tenantId, spec })
      if (!decision.allowed) {
        await record({
          tenantId,
          agentId: (ctx.get('agentId') as string | undefined) ?? null,
          conversationId: (ctx.get('sessionId') as string | undefined) ?? null,
          primitiveId: spec.id,
          runId: context.runId,
          toolCallId: context.toolCallId,
          success: false,
          durationMs: 0,
          rejectionReason: decision.reason ?? 'refused',
        })
        return { proceed: false, rejectionReason: decision.reason }
      }

      // 2. Identity. Mastra hands the sub-agent a near-complete copy of the
      // parent's context (agent-Dp3vcrIx.cjs:35119 excludes only four internal
      // keys), so without this the delegate runs as Olmo: Olmo's agentId — and
      // therefore Olmo's attached skills — and Olmo's prompt override layered
      // on top of its own instructions. Only the tenant-level facts survive.
      ctx.set('agentId', spec.id)
      ctx.set('agentName', spec.id)
      ctx.set('agentSystemPrompt', '')
      ctx.set('personaPersonality', '')

      // 3. Depth. The only thing standing between the system and a delegation
      // loop, because the agentName gate's own input is inherited.
      const depth = (ctx.get('delegationDepth') as number | undefined) ?? 0
      ctx.set('delegationDepth', depth + 1)

      // 4. The step budget this delegate declared, replacing stepCountIs(5).
      return { modifiedMaxSteps: spec.maxSteps }
    },

    onDelegationComplete: async (context: DelegationCompleteContext) => {
      const spec = getSpec(context.primitiveId)

      await record({
        tenantId: host.tenantId,
        agentId: host.agentId,
        conversationId: host.conversationId,
        primitiveId: context.primitiveId,
        runId: context.runId,
        toolCallId: context.toolCallId,
        success: context.success,
        durationMs: Math.round(context.duration ?? 0),
        errorMessage: context.error?.message ?? null,
      })

      if (!context.success) {
        // One optional fallback per spec, or none — no chains. Handing the
        // work to the fallback is the next delegation the model makes, so all
        // this does is tell the parent which one to try.
        const fallback = spec?.fallback
        context.bail()
        return {
          feedback: fallback
            ? `Delegation to "${context.primitiveId}" failed (${context.error?.message ?? 'unknown error'}). Try "${fallback}" instead, or finish with what you have.`
            : `Delegation to "${context.primitiveId}" failed (${context.error?.message ?? 'unknown error'}). Do not retry it — finish with what you have and say plainly that this step failed.`,
        }
      }

      // A sub-agent that stopped on a tool-calls step returns empty text,
      // which the parent model reads as "done, nothing to report" — a quiet
      // failure. resultText replaces what the parent sees in THIS run;
      // feedback would only reach it on the next turn.
      if (!context.result.text?.trim() && context.result.finishReason === 'tool-calls') {
        return {
          resultText: `"${context.primitiveId}" did not finish: it stopped mid-tool-call and returned nothing. Treat this as a failed step, not an empty answer.`,
        }
      }

      return undefined
    },
  }
}
