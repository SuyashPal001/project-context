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
 * The stable per-stream facts the hooks need but cannot fully trust their own
 * per-delegation context for.
 *
 * `onDelegationComplete`'s context (@mastra/core 1.64, agent.types.d.ts) has
 * no `requestContext` field at all, so it has nowhere else to read
 * tenantId/conversationId/agentId from. `onDelegationStart`'s context does
 * carry a `requestContext`, but sourcing identity from two different places
 * across the two hooks let a refusal be billed to the wrong tenant (or to
 * none, silently dropping the audit row — see the tenantId fallback below).
 * Both hooks now prefer `host`, which is constant for the whole stream() call
 * this config is attached to, and fall back to the request context only when
 * `host` does not carry a value.
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
      const tenantId = host.tenantId || (ctx.get('tenantId') as string | undefined) || ''
      const agentId = host.agentId ?? (ctx.get('agentId') as string | undefined) ?? null
      const conversationId = host.conversationId ?? (ctx.get('sessionId') as string | undefined) ?? null

      if (!spec) {
        // resolveDelegates cannot return an unregistered delegate, so this is
        // a registry bug rather than a routing one — the one refusal class
        // most worth having in the table.
        const rejectionReason = `"${context.primitiveId}" is not a registered sub-agent.`
        await record({
          tenantId,
          agentId,
          conversationId,
          primitiveId: context.primitiveId,
          runId: context.runId,
          toolCallId: context.toolCallId,
          success: false,
          durationMs: 0,
          rejectionReason,
        })
        return { proceed: false, rejectionReason }
      }

      // 1. Money first: refuse before anything is spent.
      const decision = await budget({ tenantId, spec })
      if (!decision.allowed) {
        await record({
          tenantId,
          agentId,
          conversationId,
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
      // keys). `agentName` is rewritten to the delegate's spec id — that is
      // what resolveDelegates gates on, so without this a delegate would
      // inherit agentName='olmo', resolve Olmo's own delegate map, and
      // re-delegate in a circle. `subAgentId` carries the same spec id for
      // any future delegate-scoped skills resolver to read.
      //
      // `agentId` is deliberately left UNCHANGED — it keeps the HOST's real
      // agent UUID. The delegates' own tools (generateImage.ts:36,
      // editImage.ts:43, generateVideo.ts:36, generateSong.ts:34) read
      // requestContext.get('agentId') and pass it to spendCredits as
      // actorId, which packages/foundation/credits/src/spend.ts:54 binds as
      // `${actorId}::uuid`. `agents.id` is a Postgres uuid column, so writing
      // a spec id (or '') there makes the charge throw AFTER the paid
      // generation already ran — cost spent, tenant not billed. The leak
      // this would have closed (a delegate resolving the supervisor's
      // attached skills) is inert today because no delegate declares a
      // skills resolver; the billing break is live money. When a DB-backed
      // registry lands and delegates have real agent rows, `agentId` can
      // carry a real per-delegate UUID again.
      //
      // `agentSystemPrompt` and `personaPersonality` are cleared so the
      // delegate runs on its own instructions, not Olmo's prompt override
      // layered on top. Everything else on the context — tenantId, userId,
      // sessionId, selectedModel, thinkingBudget, maxDataSensitivity,
      // testSkillInstallId, allowedSubAgents, __mcpClient — survives the copy
      // by design; `allowedSubAgents` surviving in particular is correct and
      // load-bearing for resolveDelegates' entitlement filter.
      ctx.set('agentName', spec.id)
      ctx.set('subAgentId', spec.id)
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
