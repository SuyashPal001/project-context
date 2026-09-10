import { Hono } from 'hono';
import { and, eq, desc, count } from 'drizzle-orm';
import { db } from '../db';
import { agentWorkflowRuns } from '@serverless-saas/agent-schema/agents';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';
import { randomUUID } from 'crypto';


export const agentRunsRoutes = new Hono<AppEnv>();

// resumeLabel is an implementation detail of the resume call (Task 7's
// approve route re-reads it server-side from the DB itself — a client
// never supplies it), not user-facing data — strip it before this row
// ever reaches the browser, on both the list endpoint and the GET /:id
// detail endpoint below.
function stripResumeLabel<T extends { pendingApproval?: unknown }>(run: T): T {
    if (!run.pendingApproval || typeof run.pendingApproval !== 'object') return run;
    const { resumeLabel: _resumeLabel, ...rest } = run.pendingApproval as Record<string, unknown>;
    return { ...run, pendingApproval: rest };
}

// GET /agent-runs — list all runs for tenant, newest first
agentRunsRoutes.get('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    // Optional filter by agentId via query param
    const agentId = c.req.query('agentId');
    const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(c.req.query('pageSize') ?? '20', 10) || 20));

    const conditions = [eq(agentWorkflowRuns.tenantId, tenantId)];
    if (agentId) {
        conditions.push(eq(agentWorkflowRuns.agentId, agentId));
    }

    const [{ value: total }] = await db
        .select({ value: count() })
        .from(agentWorkflowRuns)
        .where(and(...conditions));

    const rows = await db
        .select()
        .from(agentWorkflowRuns)
        .where(and(...conditions))
        .orderBy(desc(agentWorkflowRuns.startedAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

    const runs = rows.map(stripResumeLabel);

    return c.json({
        runs,
        total: Number(total),
        page,
        totalPages: Math.max(1, Math.ceil(Number(total) / pageSize)),
    });
});

// GET /agent-runs/:id — full detail of one run
agentRunsRoutes.get('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'agents', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const runId = c.req.param('id');

    const row = (await db
        .select()
        .from(agentWorkflowRuns)
        .where(and(eq(agentWorkflowRuns.id, runId), eq(agentWorkflowRuns.tenantId, tenantId)))
        .limit(1))[0];

    if (!row) {
        return c.json({ error: 'Run not found' }, 404);
    }

    const data = stripResumeLabel(row);

    return c.json({ data });
});

// PUT /agent-runs/:id/approve — approve or decline a run's pending step approval
agentRunsRoutes.put('/:id/approve', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string;

    if (!hasPermission(permissions, 'agent_runs', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const runId = c.req.param('id');
    const body = await c.req.json().catch(() => null) as { approved?: unknown } | null;
    if (!body || typeof body.approved !== 'boolean') {
        return c.json({ error: 'approved (boolean) is required' }, 400);
    }
    const approved = body.approved;

    // Atomic conditional update — same shape as tasks.approval.ts's
    // handlePlanApprove BUG-6 fix. A plain SELECT followed by an
    // unconditional fetch would let two concurrent approvals both pass.
    const [updatedRun] = await db.update(agentWorkflowRuns)
        .set({
            status: 'running',
            humanApproved: approved,
            approvedBy: userId,
        })
        .where(and(
            eq(agentWorkflowRuns.id, runId),
            eq(agentWorkflowRuns.tenantId, tenantId),
            eq(agentWorkflowRuns.status, 'awaiting_approval'),
        ))
        .returning({
            id: agentWorkflowRuns.id,
            pendingApproval: agentWorkflowRuns.pendingApproval,
        });

    if (!updatedRun) {
        return c.json({ error: 'Run cannot be approved in its current state' }, 409);
    }
    const resumeLabel = (updatedRun.pendingApproval as { resumeLabel?: string } | null)?.resumeLabel;
    if (!resumeLabel) {
        return c.json({ error: 'Run has no pending approval to act on' }, 409);
    }

    const orchestratorUrl = process.env.AGENT_ORCHESTRATOR_URL;
    const internalServiceKey = process.env.INTERNAL_SERVICE_KEY;
    if (!orchestratorUrl || !internalServiceKey) {
        return c.json({ error: 'Relay not configured' }, 503);
    }

    const res = await fetch(`${orchestratorUrl}/api/workflows/${runId}/resume`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-internal-service-key': internalServiceKey,
            'x-trace-id': c.get('traceId') ?? randomUUID(),
        },
        body: JSON.stringify({ tenantId, approved, resumeLabel }),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[agent-runs/approve] relay resume failed ${res.status}: ${text}`);
        return c.json({ error: 'Failed to dispatch resume' }, 502);
    }

    db.insert(auditLog).values({
        tenantId, actorId: userId, actorType: 'human',
        action: approved ? 'workflow_step_approved' : 'workflow_step_declined',
        resource: 'agent_workflow_run', resourceId: runId, metadata: {},
        traceId: c.get('traceId') ?? '',
    }).catch((err: unknown) => console.error('Audit log write failed:', err));

    return c.json({ success: true });
});