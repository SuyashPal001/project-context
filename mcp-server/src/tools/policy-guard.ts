/**
 * Agent policy enforcement for MCP tool calls.
 *
 * Two rules, both learned from the bug this replaces:
 *
 * 1. **Fail closed on missing context.** The previous guard returned early when
 *    `agentId` was absent, and `x-agent-id` is an optional header — so omitting
 *    one header skipped the policy check entirely, including the human-approval
 *    gate for sending mail. A guard that cannot evaluate its policy must deny.
 *
 * 2. **Guard reads too.** The previous guard ran only on send and reply, leaving
 *    mailbox reads and arbitrary Gmail search unguarded even when a blocking
 *    policy existed. Reading someone's mail is not a lesser action than sending.
 *
 * A policy-store failure propagates rather than being swallowed, for the same
 * reason: an outage must not read as permission.
 */

export interface ToolContext {
  tenantId: string;
  agentId?: string;
}

export interface PolicyDecision {
  blocked: boolean;
  requiresApproval: boolean;
}

export type PolicyChecker = (
  tenantId: string,
  agentId: string,
  action: string,
) => Promise<PolicyDecision>;

export class PolicyDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyDeniedError';
  }
}

/** Throws unless the action is positively permitted. */
export async function assertActionAllowed(
  ctx: ToolContext,
  action: string,
  checkPolicy: PolicyChecker,
): Promise<void> {
  if (!ctx.agentId) {
    throw new PolicyDeniedError(
      `Action '${action}' requires agent context — supply x-agent-id so agent policy can be evaluated`,
    );
  }

  const decision = await checkPolicy(ctx.tenantId, ctx.agentId, action);

  if (decision.blocked) {
    throw new PolicyDeniedError(`Action '${action}' is blocked by agent policy`);
  }
  if (decision.requiresApproval) {
    throw new PolicyDeniedError(
      `Action '${action}' requires human approval before execution`,
    );
  }
}
