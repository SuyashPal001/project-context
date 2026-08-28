import { agentTasks, taskSteps, taskEvents, agents } from '@serverless-saas/agent-schema';
import { eq, and } from 'drizzle-orm';
import { pushWebSocketEvent } from '../lib/websocket';
import { publishToQueue } from '@serverless-saas/queue';
import { db, AGENT_ORCHESTRATOR_URL, INTERNAL_SERVICE_KEY, MAX_STEPS_PER_TASK, sanitizeTaskInput, makeLog, extractAttachments, getPastSuccessfulPlans } from './taskWorker.utils';

export async function handlePlanning(
    taskId: string,
    traceId: string,
    extraContext?: string,
    feedbackHistoryMap?: Record<string, Array<{ round: number; feedback: string; generalInstruction: string | null; replannedAt: string }>>
) {
    const log = makeLog(traceId, taskId);
    const task = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, taskId) });
    if (!task) throw new Error(`Task not found: ${taskId}`);

    try {
        await db.delete(taskSteps).where(and(eq(taskSteps.taskId, task.id), eq(taskSteps.status, 'pending')));

        const agent = task.agentId ? (await db.select({ name: agents.name }).from(agents).where(eq(agents.id, task.agentId)).limit(1))[0] : null;

        log('info', 'starting pre-relay work');
        const preRelayStart = Date.now();

        const [ragContext, { attachmentContext }] = await Promise.all([
            getPastSuccessfulPlans(task.tenantId, task.title, task.description).catch(ragErr => {
                log('warn', 'RAG lookup failed (non-fatal)', { error: (ragErr as Error).message });
                return null;
            }),
            extractAttachments(task.tenantId, task.attachmentFileIds ?? []),
        ]);

        log('info', 'pre-relay work done', { ms: Date.now() - preRelayStart });

        const combinedExtraContext = [ragContext, extraContext].filter(Boolean).join('\n\n') || undefined;

        log('info', 'relay call starting');
        const response = await fetch(`${AGENT_ORCHESTRATOR_URL}/api/tasks/plan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-internal-service-key': INTERNAL_SERVICE_KEY(), 'x-trace-id': traceId },
            body: JSON.stringify({
                taskId: task.id, agentId: task.agentId, tenantId: task.tenantId,
                title: `<user_input>${sanitizeTaskInput(task.title)}</user_input>`,
                description: task.description ? `<user_input>${sanitizeTaskInput(task.description)}</user_input>` : null,
                acceptanceCriteria: task.acceptanceCriteria, agentName: agent?.name ?? null,
                referenceText: task.referenceText ? `<user_input>${task.referenceText}</user_input>` : null,
                links: (task.links ?? []).map((l: string) => `<user_input>${l}</user_input>`),
                attachmentContext: attachmentContext ?? null,
                ...(combinedExtraContext ? { extraContext: `<user_input>${combinedExtraContext}</user_input>` } : {}),
            }),
            signal: AbortSignal.timeout(55_000),
        });

        if (!response.ok) throw new Error(`Relay planning failed: ${response.status}`);

        let body: { steps?: Array<{ title: string; description: string; toolName?: string; confidenceScore?: number; reasoning?: string }>; clarificationNeeded?: boolean; questions?: string[] };
        try { body = await response.json() as typeof body; }
        catch (jsonErr) { throw new Error(`Relay returned malformed JSON: ${(jsonErr as Error).message}`); }

        if (body.clarificationNeeded) {
            const questions = body.questions ?? [];
            const reason = `Agent needs clarification:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;
            await db.update(agentTasks).set({ status: 'blocked', blockedReason: reason, updatedAt: new Date() }).where(eq(agentTasks.id, task.id));
            // phase: 'planning' — no charge has happened yet for this run (charging
            // starts at execute_task/handleExecution), so this clarification must NOT
            // bump the credit charge-attempt counter (see handleExecution's and
            // handleWorkflowApprove's attempt count queries, which filter this out).
            await db.insert(taskEvents).values({ taskId: task.id, tenantId: task.tenantId, actorType: 'agent', actorId: task.agentId ?? 'system', eventType: 'clarification_requested', payload: { questions, phase: 'planning' } });
            await pushWebSocketEvent(task.tenantId, { type: 'task.status.changed', taskId: task.id, status: 'blocked' });
            return;
        }

        const { steps } = body;
        if (!steps || steps.length === 0) throw new Error('Relay returned no steps and no clarification');
        if (steps.length > MAX_STEPS_PER_TASK) throw new Error(`Relay proposed ${steps.length} steps (max ${MAX_STEPS_PER_TASK})`);

        const insertedSteps = await db.insert(taskSteps).values(steps.map((step, index) => ({
            taskId: task.id, tenantId: task.tenantId, stepNumber: index + 1,
            title: step.title, description: step.description, toolName: step.toolName ?? null,
            reasoning: step.reasoning ?? null, confidenceScore: step.confidenceScore != null ? String(step.confidenceScore) : null,
            status: 'pending' as const, feedbackHistory: feedbackHistoryMap?.[step.title] ?? [],
        }))).returning({ id: taskSteps.id, stepNumber: taskSteps.stepNumber, title: taskSteps.title, description: taskSteps.description, toolName: taskSteps.toolName, reasoning: taskSteps.reasoning, confidenceScore: taskSteps.confidenceScore });

        for (const step of insertedSteps) {
            await pushWebSocketEvent(task.tenantId, { type: 'task.step.created', taskId: task.id, step: { id: step.id, stepNumber: step.stepNumber, title: step.title, description: step.description ?? null, toolName: step.toolName ?? null, reasoning: step.reasoning ?? null, confidenceScore: step.confidenceScore ?? null, status: 'pending' } });
        }

        const scores = steps.filter(s => s.confidenceScore != null).map(s => s.confidenceScore!);
        const avgConfidence = scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2) : null;

        await db.update(agentTasks).set({ status: 'awaiting_approval', confidenceScore: avgConfidence, updatedAt: new Date() }).where(eq(agentTasks.id, task.id));
        await db.insert(taskEvents).values({ taskId: task.id, tenantId: task.tenantId, actorType: 'agent', actorId: task.agentId ?? 'system', eventType: 'plan_proposed', payload: { stepCount: steps.length } });
        await pushWebSocketEvent(task.tenantId, { type: 'task.status.changed', taskId: task.id, status: 'awaiting_approval' });

        const sqsUrl = process.env.SQS_PROCESSING_QUEUE_URL;
        if (sqsUrl) await publishToQueue(sqsUrl, { type: 'notification.fire', tenantId: task.tenantId, messageType: 'task.awaiting_approval', actorId: task.agentId ?? 'system', actorType: 'agent', recipientIds: [task.createdBy], data: { taskId: task.id, taskTitle: task.title } });

    } catch (err) {
        const reason = `Planning failed: ${(err as Error).message}`;
        log('error', 'Planning fatal error', { error: (err as Error).message });
        try {
            await db.update(agentTasks).set({ status: 'blocked', blockedReason: reason, updatedAt: new Date() }).where(eq(agentTasks.id, taskId));
            await db.insert(taskEvents).values({ taskId: task.id, tenantId: task.tenantId, actorType: 'agent', actorId: task.agentId ?? 'system', eventType: 'status_changed', payload: { from: task.status, to: 'blocked', reason } });
            await pushWebSocketEvent(task.tenantId, { type: 'task.status.changed', taskId: task.id, status: 'blocked' });
        } catch (recoveryErr) {
            log('error', 'Recovery write failed', { error: (recoveryErr as Error).message });
        }
    }
}
