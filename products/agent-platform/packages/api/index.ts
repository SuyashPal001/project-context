import { Hono } from 'hono';
import type { AppEnv } from '@serverless-saas/types';
import { and, count, eq } from 'drizzle-orm';
import { db } from './db';
import { registerUsageCounter } from '@serverless-saas/entitlements';
import { agents } from '@serverless-saas/agent-schema/agents';

// API routes
import { agentsRoutes } from './routes/agents';
import { agentSkillsRoutes } from './routes/agent-skills';
import { agentPoliciesRoutes } from './routes/agent-policies';
import { agentRunsRoutes } from './routes/agent-runs';
import { conversationsRoutes } from './routes/conversations';
import { messagesRoutes } from './routes/messages';
import documentsRoutes from './routes/documents';
import { evalsFeedbackRoutes, evalsRoutes } from './routes/evals';
import { tasksRoutes } from './routes/tasks';
import { plansRoutes } from './routes/plans';
import { prdsRoutes } from './routes/prds';
import { milestonesRoutes } from './routes/milestones';
import { pagesRoutes } from './routes/pages';
import { llmProvidersRoutes } from './routes/llm-providers';
import { widgetRoutes } from './routes/widget';

// Internal routes
import internalRetrieveRoute from './routes/internal/retrieve';
import internalEvalsRoute from './routes/internal/evals';
import internalToolCallsRoute from './routes/internal/tool-calls';
import internalKnowledgeGapsRoute from './routes/internal/knowledge-gaps';
import internalTasksRoute from './routes/internal/tasks';
import { internalWorkflowsRoute } from './routes/internal/workflows';
import internalGuardrailsRoute from './routes/internal/guardrails';
import internalFairnessRoute from './routes/internal/fairness';
import { handleArtifactNotify } from './routes/internal/artifacts';

// Ops handlers
import { agentTemplatesRoutes } from './routes/agentTemplates';
import { handleListProviders, handleCreateProvider, handlePatchProvider } from './routes/ops.providers';
import { handleKnowledgeGaps, handleEvalScores, handleToolPerformance, handleEvalsResults } from './routes/ops.intelligence';
import { handleFinops, handleOverview } from './routes/ops.finops';
import { handleListFairnessReviews, handleOpsRunFairness, handleListResponseAudits } from './routes/ops.fairness';

let countersRegistered = false;
function registerCounters(): void {
    if (countersRegistered) return;
    countersRegistered = true;
    registerUsageCounter('agents', async (tenantId) => {
        const [row] = await db.select({ c: count() }).from(agents)
            .where(and(eq(agents.tenantId, tenantId), eq(agents.status, 'active')));
        return Number(row?.c ?? 0);
    });
}

export function mountPublicRoutes(publicApi: Hono<AppEnv>): void {
    publicApi.route('/widget', widgetRoutes);
}

export function mountApiRoutes(api: Hono<AppEnv>): void {
    registerCounters();
    api.route('/agents', agentsRoutes);
    api.route('/agents', agentSkillsRoutes);
    api.route('/agents', agentPoliciesRoutes);
    api.route('/agent-runs', agentRunsRoutes);
    api.route('/conversations', evalsFeedbackRoutes);
    api.route('/conversations', conversationsRoutes);
    api.route('/conversations', messagesRoutes);
    api.route('/evals', evalsRoutes);
    api.route('/llm-providers', llmProvidersRoutes);
    api.route('/documents', documentsRoutes);
    api.route('/tasks', tasksRoutes);
    api.route('/plans', plansRoutes);
    api.route('/prds', prdsRoutes);
    api.route('/milestones', milestonesRoutes);
    api.route('/pages', pagesRoutes);
}

export function mountInternalRoutes(internalApi: Hono<AppEnv>): void {
    internalApi.route('/internal', internalRetrieveRoute);
    internalApi.route('/internal/evals', internalEvalsRoute);
    internalApi.route('/internal/tool-calls', internalToolCallsRoute);
    internalApi.route('/internal/knowledge-gaps', internalKnowledgeGapsRoute);
    internalApi.route('/internal/tasks', internalTasksRoute);
    internalApi.route('/internal/workflows', internalWorkflowsRoute);
    internalApi.route('/internal/guardrails', internalGuardrailsRoute);
    internalApi.route('/internal/fairness', internalFairnessRoute);
    internalApi.post('/internal/artifacts/notify', handleArtifactNotify);
}

export function mountOpsRoutes(opsApp: Hono<AppEnv>): void {
    const agentOps = new Hono<AppEnv>();
    agentOps.get('/providers', handleListProviders);
    agentOps.post('/providers', handleCreateProvider);
    agentOps.patch('/providers/:id', handlePatchProvider);
    agentOps.get('/agent-intelligence/knowledge-gaps', handleKnowledgeGaps);
    agentOps.get('/agent-intelligence/eval-scores', handleEvalScores);
    agentOps.get('/agent-intelligence/tool-performance', handleToolPerformance);
    agentOps.get('/evals/results', handleEvalsResults);
    agentOps.get('/finops', handleFinops);
    agentOps.get('/overview', handleOverview);
    agentOps.get('/fairness', handleListFairnessReviews);
    agentOps.post('/fairness/:agentId/run', handleOpsRunFairness);
    agentOps.get('/fairness/response-audits', handleListResponseAudits);
    opsApp.route('/ops', agentOps);
    opsApp.route('/ops/agent-templates', agentTemplatesRoutes);
}

export const agentProduct = {
    mountPublicRoutes,
    mountApiRoutes,
    mountInternalRoutes,
    mountOpsRoutes,
};
