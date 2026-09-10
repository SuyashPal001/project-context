import type {
  DelegationConfig, DelegationCompleteContext, DelegationStartContext,
} from '@mastra/core/agent'
import { getSpecByAgentId } from './sources.js'
import { checkDelegationBudget } from './budget.js'
import { recordDelegation } from './link.js'

export interface HookDeps {
  budget?: typeof checkDelegationBudget
  record?: typeof recordDelegation
  /**
   * Maps a hook's `primitiveId` — the delegate AGENT's id, e.g.
   * 'pc-director-delegate' — to its spec. Injectable so a test can supply a
   * spec shape the registry does not contain (one with a `fallback`).
   */
  lookup?: typeof getSpecByAgentId
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
 * field, so this config has to be passed at every call site that can reach
 * Olmo — and on SSE, into the approveToolCall/declineToolCall resumes too,
 * because a resumed run restores memory from its snapshot, not options. A
 * hook wired into only some call sites silently does not run on the others.
 *
 * Three call sites reach Olmo:
 * - routes/chatStream.ts (SSE) — wired, gated on activeAgent === platformAgent.
 * - index.ts (WebSocket) — wired, but inert today: that path never sets
 *   agentName, so resolveDelegates returns {} and there is nothing to govern.
 * - mastra/agent.ts's createTenantAgent (the task path) — NOT wired. Its
 *   Proxy forwards platformAgent.generate() with no `delegation` option, so a
 *   task run on an Olmo row reaches the delegates with no budget check, no
 *   audit row and default step counts. A known ungoverned path, left for a
 *   follow-up spec; see the spec's "Known gaps after implementation".
 */
export function buildDelegationConfig(host: DelegationHost, deps: HookDeps = {}): DelegationConfig {
  const budget = deps.budget ?? checkDelegationBudget
  const record = deps.record ?? recordDelegation
  const lookup = deps.lookup ?? getSpecByAgentId

  return {
    // If a hook throws, fail the delegation. The default ('warn') proceeds
    // with the original prompt and result — which for a credit hook means
    // work done and nobody billed, silently. Hook throws are also recorded on
    // the run context under __mastra_delegationHookErrors.
    hookErrorStrategy: 'throw',

    onDelegationStart: async (context: DelegationStartContext) => {
      const ctx = context.requestContext
      const spec = lookup(context.primitiveId)
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
      // what resolveDelegates gates on. No current delegate calls
      // resolveDelegates (only platformAgent's `agents:` resolver does), so
      // this is not closing a live loop; it stops a delegate that later gains
      // a dynamic `agents:` resolver from inheriting agentName='olmo' and
      // with it Olmo's delegate map. `subAgentId` carries the same spec id for
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

      // 3. Depth. Defence in depth alongside the agentName rewrite: once a
      // delegate declares its own dynamic `agents:` resolver, this is what
      // stops it re-delegating past the host's ceiling.
      const depth = (ctx.get('delegationDepth') as number | undefined) ?? 0
      ctx.set('delegationDepth', depth + 1)

      // 4. The step budget this delegate declared, replacing stepCountIs(5).
      return { modifiedMaxSteps: spec.maxSteps }
    },

    onDelegationComplete: async (context: DelegationCompleteContext) => {
      const spec = lookup(context.primitiveId)
      // Spec id once a spec is found — that is the name Olmo routes by and the
      // one the audit table is queried by. The raw Agent id survives only for
      // an unregistered primitive, where there is no spec id to use.
      const name = spec?.id ?? context.primitiveId

      await record({
        tenantId: host.tenantId,
        agentId: host.agentId,
        conversationId: host.conversationId,
        primitiveId: name,
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
        //
        // No bail(). bail() sets __mastra_delegationBailed, which ends the
        // supervisor's loop after the current step (agent-Dp3vcrIx.cjs:26108,
        // :27185) — Olmo would never get the step in which to try the
        // fallback or explain the failure, the two things this text asks of it.
        //
        // Mastra has two failure paths and they honour different fields:
        // - The delegate FINISHED with finishReason 'error' (success is
        //   `finishReason !== "error"`, cjs:35556). `resultText` replaces the
        //   tool result the parent reads in THIS run (cjs:35570-35573).
        // - The delegate THREW (the catch at cjs:35609). `resultText` is
        //   ignored there; only `feedback` is used, saved to the supervisor's
        //   memory for the next turn (cjs:35633-35655), and the tool then
        //   throws, so this run's parent sees a tool-error instead.
        // So both are returned: resultText for the first path, and a factual
        // (not instructional — it is read a turn later) feedback note for the
        // second, which on the first path is a harmless record in memory.
        const fallback = spec?.fallback
        const reason = context.error?.message ?? 'unknown error'
        return {
          resultText: fallback
            ? `Delegation to "${name}" failed (${reason}). Try "${fallback}" instead, or finish with what you have.`
            : `Delegation to "${name}" failed (${reason}). Do not retry it — finish with what you have and say plainly that this step failed.`,
          feedback: `Delegation to "${name}" failed (${reason}).`,
        }
      }

      // A sub-agent that stopped on a tool-calls step returns empty text,
      // which the parent model reads as "done, nothing to report" — a quiet
      // failure. resultText replaces what the parent sees in THIS run;
      // feedback would only reach it on the next turn.
      if (!context.result.text?.trim() && context.result.finishReason === 'tool-calls') {
        return {
          resultText: `"${name}" did not finish: it stopped mid-tool-call and returned nothing. Treat this as a failed step, not an empty answer.`,
        }
      }

      return undefined
    },
  }
}
