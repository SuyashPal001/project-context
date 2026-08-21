/**
 * Calls back into the agent-orchestrator to ask a human to approve a tool
 * call that the policy guard has flagged as `requiresApproval`.
 *
 * The orchestrator's `POST /mcp/approval-request` (apps/agent-orchestrator/
 * src/routes/sessions.ts) already implements the human side of this round
 * trip — it emits `approval_request` over the chat session's SSE stream and
 * blocks on a Promise resolved by the frontend's decision, with its own 30s
 * auto-deny timeout. This module is the missing caller.
 *
 * Fails closed: any network error, non-2xx response, or timeout here is
 * treated as a denial, for the same reason the policy guard itself fails
 * closed on missing context — an outage must not read as permission.
 */

const ORCHESTRATOR_URL = process.env.AGENT_ORCHESTRATOR_URL ?? 'http://localhost:3001';

// Slightly above the orchestrator's own 30s auto-deny timeout, so this
// request always gets a real response body back instead of aborting first.
const APPROVAL_TIMEOUT_MS = 35_000;

export interface ApprovalRequest {
  tenantId: string;
  sessionId: string;
}

export async function requestApprovalFromOrchestrator(
  ctx: ApprovalRequest,
  action: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/mcp/approval-request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '',
      },
      body: JSON.stringify({
        tenantId: ctx.tenantId,
        sessionId: ctx.sessionId,
        approvalId: crypto.randomUUID(),
        toolName: action,
        args,
      }),
      signal: AbortSignal.timeout(APPROVAL_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(`[approval] orchestrator returned ${res.status} for action '${action}' — denying`);
      return false;
    }

    const body = (await res.json()) as { approved?: boolean };
    return body.approved === true;
  } catch (err) {
    console.error(`[approval] request failed for action '${action}':`, (err as Error).message);
    return false;
  }
}
