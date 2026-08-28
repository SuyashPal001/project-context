import { agentTasks, taskSteps, taskEvents, agents } from '@serverless-saas/agent-schema';
import { eq, and, asc, sql } from 'drizzle-orm';
import { pushWebSocketEvent } from '../lib/websocket';
import { getCacheClient } from '@serverless-saas/cache';
import { db, AGENT_ORCHESTRATOR_URL, INTERNAL_SERVICE_KEY, sanitizeTaskInput, makeLog, extractAttachments } from './taskWorker.utils';
import { startTaskHeartbeat, clearTaskHeartbeat } from '../lib/task-heartbeat';

export async function handleExecution(taskId: string, traceId: string, attemptOverride?: number) {
    const log = makeLog(traceId, taskId);
    const task = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, taskId) });
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const agent = task.agentId ? (await db.select({ name: agents.name }).from(agents).where(eq(agents.id, task.agentId)).limit(1))[0] : null;
    const steps = await db.select().from(taskSteps).where(eq(taskSteps.taskId, taskId)).orderBy(asc(taskSteps.stepNumber));

    // Each clarify-and-resume cycle needs its OWN credit charge key
    // (task:{taskId}:attempt:{n} — see apps/agent-orchestrator/src/credits.ts
    // taskChargeKey()), or the resumed run's chargeTaskEstimate call replays
    // the ORIGINAL (already-refunded-by-onTaskComment) debit under the
    // unsuffixed task:{taskId} key instead of actually charging. `attempt` is
    // the number of EXECUTION-phase clarification rounds already completed
    // for this task — i.e. ones that interrupted an already-charged run and
    // triggered a refund (onTaskComment, tagged phase: 'execution' at
    // insert). A PLANNING-phase clarification (taskWorker.planning.ts, tagged
    // phase: 'planning') happens before this task has ever been charged, so
    // it must NOT bump this counter — the run that eventually executes is
    // still genuinely the first charged attempt. 0 for a task that was never
    // clarified mid-execution — the common case — keeps the exact original
    // key.
    //
    // `attemptOverride` is supplied by the publisher (tasks.approval.ts's
    // handlePlanApprove) at enqueue time, computed ONCE there and carried in
    // the SQS message body, precisely so an SQS redelivery of this exact
    // message (the fetch below can run up to 290s against a Lambda timeout
    // around 300s, so redelivery is plausible) replays the SAME attempt
    // rather than recomputing a higher one if a clarification landed on this
    // task in the gap between deliveries — which would otherwise charge the
    // retry under a fresh key: a real double charge on a duplicate delivery.
    // The live query below is kept only as a fallback for a message enqueued
    // before this field existed.
    const attempt = attemptOverride ?? (await db.select({ id: taskEvents.id }).from(taskEvents)
        .where(and(
            eq(taskEvents.taskId, taskId),
            eq(taskEvents.eventType, 'clarification_requested'),
            sql`${taskEvents.payload}->>'phase' = 'execution'`,
        ))).length;
    const pendingSteps = steps.filter((s: { status: string }) => s.status === 'pending');

    if (pendingSteps.length === 0 && steps.every((s: { status: string }) => s.status === 'done')) {
        log('info', 'All steps already done, skipping relay');
        await db.update(agentTasks).set({ status: 'review', completedAt: new Date(), updatedAt: new Date() }).where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, 'in_progress')));
        await pushWebSocketEvent(task.tenantId, { type: 'task.status.changed', taskId: task.id, status: 'review' });
        return;
    }

    await startTaskHeartbeat(getCacheClient() as never, taskId, task.tenantId);

    const { attachmentContext } = await extractAttachments(task.tenantId, task.attachmentFileIds ?? []);

    let response: Response;
    try {
        response = await fetch(`${AGENT_ORCHESTRATOR_URL}/api/tasks/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-internal-service-key': INTERNAL_SERVICE_KEY(), 'x-trace-id': traceId },
            body: JSON.stringify({
                taskId: task.id, agentId: task.agentId, tenantId: task.tenantId,
                taskTitle: `<user_input>${sanitizeTaskInput(task.title)}</user_input>`,
                taskDescription: task.description ? `<user_input>${sanitizeTaskInput(task.description)}</user_input>` : '',
                agentName: agent?.name ?? null,
                referenceText: task.referenceText ? `<user_input>${task.referenceText}</user_input>` : null,
                links: (task.links ?? []).map((l: string) => `<user_input>${l}</user_input>`),
                attachmentContext: attachmentContext ?? null,
                steps: pendingSteps.map((s: typeof taskSteps.$inferSelect) => ({ id: s.id, stepNumber: s.stepNumber, title: sanitizeTaskInput(s.title), description: sanitizeTaskInput(s.description), toolName: s.toolName })),
                attempt,
            }),
            signal: AbortSignal.timeout(290_000),
        });
    } catch (err: unknown) {
        const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
        const reason = isTimeout ? 'Execution timeout — relay took too long' : `Relay execution failed: ${err instanceof Error ? err.message : String(err)}`;
        await clearTaskHeartbeat(getCacheClient() as never, taskId);
        await db.update(agentTasks).set({ status: 'blocked', blockedReason: reason, updatedAt: new Date() }).where(eq(agentTasks.id, taskId));
        await pushWebSocketEvent(task.tenantId, { type: 'task.status.changed', taskId, status: 'blocked', blockedReason: reason });
        return;
    }

    if (!response.ok) {
        const reason = `Relay rejected execution: HTTP ${response.status}`;
        await clearTaskHeartbeat(getCacheClient() as never, taskId);
        await db.update(agentTasks).set({ status: 'blocked', blockedReason: reason, updatedAt: new Date() }).where(eq(agentTasks.id, taskId));
        await db.insert(taskEvents).values({ taskId: task.id, tenantId: task.tenantId, actorType: 'agent', actorId: 'system', eventType: 'status_changed', payload: { from: task.status, to: 'blocked', reason } });
        await pushWebSocketEvent(task.tenantId, { type: 'task.status.changed', taskId: task.id, status: 'blocked' });
    }
}
