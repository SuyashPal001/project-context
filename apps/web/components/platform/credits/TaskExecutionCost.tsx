'use client';

import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { ApproveCost } from './ApproveCost';
import { AVERAGE_STEP_TOKENS, DEFAULT_TASK_MODEL, rateSubjectFor } from '@/lib/hooks/useCredits';

interface AgentDetail {
    llmProvider?: { model: string } | null;
}

export interface TaskExecutionCostProps {
    /** task.agentId — null only for a task with no agent, which shouldn't
     * reach the plan-review phase in practice, but is handled defensively. */
    agentId: string | null;
    /** Number of steps in the approved plan — same input estimateTaskMicro()
     * takes as `steps.length` on the real charge path. */
    stepCount: number;
    onApprove: () => void;
}

/**
 * Approving a plan (PUT /tasks/:taskId/plan/approve) is the human action
 * that enqueues `execute_task`, which the worker relays to the orchestrator,
 * which calls estimateTaskMicro(steps.length, model) and then
 * chargeTaskEstimate() before a single step runs — see
 * apps/agent-orchestrator/src/routes/tasks.execution.ts:runMastraTaskSteps.
 * This is therefore the moment the tenant's credits are actually committed,
 * and where the estimate-and-approve gate belongs.
 *
 * The model used for the real charge comes from the agent's assigned
 * llm_provider (llmProviders.model, via fetchAgentModelSelection on the
 * orchestrator) — not the `agents.model` display column, which can be a
 * human-readable label instead of the rate-lookup slug. GET /api/v1/agents/:id
 * already returns `llmProvider.model`, so that's what's fetched here.
 */
export function TaskExecutionCost({ agentId, stepCount, onApprove }: TaskExecutionCostProps) {
    const { data: agent, isLoading, isError } = useQuery<AgentDetail>({
        queryKey: ['agent', agentId],
        queryFn: () => api.get<AgentDetail>(`/api/v1/agents/${agentId}`),
        enabled: !!agentId,
    });

    if (agentId && isLoading) {
        return (
            <div className="px-3 py-2 text-xs text-muted-foreground" data-testid="task-execution-cost-loading">
                Estimating cost…
            </div>
        );
    }

    // Model isn't knowable (agent lookup failed, or there's no agent at
    // all) — per policy, show no figure rather than a wrong one. Approve
    // must still work here: spend_credits() on the real charge is the
    // authoritative check and fails closed on its own (it posts an
    // "Insufficient credits" comment and blocks the task if the tenant is
    // actually broke) — this preview not having a number is not a reason to
    // take away the only way to approve the plan at all.
    if (!agentId || isError) {
        return (
            <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs" data-testid="task-execution-cost-unknown">
                <span className="text-muted-foreground">A cost will apply when this runs — couldn&apos;t estimate it in advance.</span>
                <Button type="button" size="sm" onClick={onApprove}>
                    Approve
                </Button>
            </div>
        );
    }

    const model = agent?.llmProvider?.model ?? DEFAULT_TASK_MODEL;
    const subject = rateSubjectFor(model);

    return (
        <ApproveCost
            variant="inline"
            resourceType="llm_tokens"
            subject={subject}
            params={{
                inputTokens: AVERAGE_STEP_TOKENS.input * stepCount,
                outputTokens: AVERAGE_STEP_TOKENS.output * stepCount,
            }}
            onApprove={onApprove}
        />
    );
}
