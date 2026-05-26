import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { healthRoutes } from './routes/health';
import { errorHandler } from './middleware/error-handler';
import type { AppEnv } from './types';
import { userUpsertMiddleware } from './middleware/userUpsert';
import { onboardingRoutes } from './routes/onboarding';
import { apiKeyAuthMiddleware } from './middleware/apiKeyAuth';
import { tenantResolutionMiddleware } from './middleware/tenantResolution';
import { sessionValidationMiddleware } from './middleware/sessionValidation';
import { entitlementsMiddleware } from './middleware/entitlements';
import { permissionsMiddleware } from './middleware/permissions';
import { queryScopeMiddleware } from './middleware/queryScope';
import { authRoutes, authPublicRoutes } from './routes/auth';
import { except } from 'hono/combine';
import { invitationsPublicRoutes, memberInviteRoutes } from './routes/invitations';
import { membersRoutes } from './routes/members';
import { rolesRoutes } from './routes/roles';
import { apiKeysRoutes } from './routes/api-keys';
import { agentsRoutes } from './routes/agents';
import { agentSkillsRoutes } from './routes/agent-skills';
import { agentPoliciesRoutes } from './routes/agent-policies';
import { agentRunsRoutes } from './routes/agent-runs';
import { conversationsRoutes } from './routes/conversations';
import { messagesRoutes } from './routes/messages';
import { notificationsRoutes } from './routes/notifications';
import { auditLogRoutes } from './routes/audit-log';
import { billingRoutes } from './routes/billing';
import { brandingRoutes } from './routes/branding';
import { opsApp } from './ops-app';
import { authInjectionMiddleware } from './middleware/authInjection';
import { entitlementsRoutes } from './routes/entitlements';
import { tenantsRoutes } from './routes/tenants';
import { usageRoutes } from './routes/usage';
import { webhooksRoutes } from './routes/webhooks';
import { filesRoutes } from './routes/files';
import { lakehouseRoutes } from './routes/lakehouse';
import { eventsRoutes } from './routes/events';
import { integrationsRoutes, googleOAuthCallbackRoute, zohoOAuthCallbackRoute, jiraOAuthCallbackRoute } from './routes/integrations';
import { githubIntegrationRoute } from './routes/integrations.github';
import { githubCallbackRoute } from './routes/integrations.github.callback';
import { githubWebhookRoute } from './routes/integrations.github.webhook';
import { llmProvidersRoutes } from './routes/llm-providers';
import { usageRecordingMiddleware } from './middleware/usageRecording';
import { widgetRoutes } from './routes/widget';
import { sessionsRoutes } from './routes/sessions';
import { usersRoutes } from './routes/users';
import { workspacesRoutes } from './routes/workspaces';
import documentsRoutes from './routes/documents';
import internalRetrieveRoute from './routes/internal/retrieve';
import { evalsFeedbackRoutes, evalsRoutes } from './routes/evals';
import { tasksRoutes } from './routes/tasks';
import { plansRoutes } from './routes/plans';
import { prdsRoutes } from './routes/prds';
import { milestonesRoutes } from './routes/milestones';
import { pagesRoutes } from './routes/pages';
import internalEvalsRoute from './routes/internal/evals';
import internalToolCallsRoute from './routes/internal/tool-calls';
import internalKnowledgeGapsRoute from './routes/internal/knowledge-gaps';
import internalTasksRoute from './routes/internal/tasks';
import { internalWorkflowsRoute } from './routes/internal/workflows';
import internalIntegrationsRoute from './routes/internal/integrations';
import internalGuardrailsRoute from './routes/internal/guardrails';
import internalFairnessRoute from './routes/internal/fairness';
import { handleArtifactNotify } from './routes/internal/artifacts';
import { randomUUID } from 'crypto';
import { initCognito } from '@serverless-saas/auth';
import { getCacheClient } from '@serverless-saas/cache';

initCognito({
    region:     process.env.AWS_REGION ?? 'ap-south-1',
    userPoolId: process.env.COGNITO_USER_POOL_ID!,
    clientId:   process.env.COGNITO_CLIENT_ID!,
});

const app = new Hono<AppEnv>();

// Global middlewaregit p
app.use('*', cors());

// First middleware — generates traceId for every request
app.use('*', async (c, next) => {
    c.set('traceId', randomUUID());
    c.set('startTime', Date.now());
    await next();
});

app.onError(errorHandler);

// Health routes — bypass all auth/tenant middleware
app.route('/health', healthRoutes);

const publicApi = new Hono<AppEnv>();
publicApi.route('/auth', authPublicRoutes);
publicApi.route('/widget', widgetRoutes);
publicApi.route('/integrations', googleOAuthCallbackRoute); // Google OAuth callback — no auth
publicApi.route('/integrations', zohoOAuthCallbackRoute);   // Zoho OAuth callback — no auth
publicApi.route('/integrations', jiraOAuthCallbackRoute);   // Jira OAuth callback — no auth
publicApi.route('/integrations', githubCallbackRoute);      // GitHub App install callback — no auth
publicApi.route('/integrations', githubWebhookRoute);       // GitHub webhook receiver — HMAC verified

const api = new Hono<AppEnv>();

// ── Middleware chain ──────────────────────────────────────────────────────────

// Step 1: JWT extraction
api.use('*', authInjectionMiddleware);

// Step 1b: Global rate limiting
// Tenant-keyed (60 req/min) when JWT carries custom:tenantId; IP-keyed (20 req/min) otherwise.
// Uses sliding-window INCR+EXPIRE on a per-minute bucket key.
api.use('*', async (c, next) => {
    const jwtPayload = c.get('jwtPayload') as Record<string, unknown> | undefined;
    const tenantId = typeof jwtPayload?.['custom:tenantId'] === 'string'
        ? (jwtPayload['custom:tenantId'] as string)
        : undefined;

    const minute = Math.floor(Date.now() / 60_000);
    let key: string;
    let limit: number;

    if (tenantId) {
        key = `ratelimit:${tenantId}:${minute}`;
        limit = 60;
    } else {
        const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim()
            ?? c.req.header('x-real-ip')
            ?? 'unknown';
        key = `ratelimit:ip:${ip}:${minute}`;
        limit = 20;
    }

    const cache = getCacheClient();
    const count = await cache.incr(key);
    if (count === 1) {
        await cache.expire(key, 60);
    }

    if (count > limit) {
        c.header('Retry-After', '60');
        return c.json({ error: 'Rate limit exceeded', retryAfter: 60 }, 429);
    }

    await next();
});

// Step 2: User upsert
api.use('*', userUpsertMiddleware);

// Onboarding — needs auth + upsert, tenantResolution handles empty tenantId
api.route('/onboarding', onboardingRoutes);
api.route('/invitations', invitationsPublicRoutes);
api.route('/tenants', tenantsRoutes);

// Step 3: API key auth
api.use('*', apiKeyAuthMiddleware);

// ── Secure middleware — runs for all routes below ─────────────────────────────

// Step 4: Tenant resolution
api.use('*', tenantResolutionMiddleware);

// Step 5: Session validation — skipped for /auth/me and /auth/tenants (called pre-session at login)
api.use('*', except(['/auth/me', '/auth/tenants'], sessionValidationMiddleware));

// Step 6: Entitlements
api.use('*', entitlementsMiddleware);

// Step 7: Permissions
api.use('*', permissionsMiddleware);

// Step 8: Query scope
api.use('*', queryScopeMiddleware);

// Step 9: Usage Recording
api.use('*', usageRecordingMiddleware);

// ── Secure routes ─────────────────────────────────────────────────────────────
api.route('/auth', authRoutes);
api.route('/members', membersRoutes);
api.route('/members', memberInviteRoutes);
api.route('/roles', rolesRoutes);
api.route('/api-keys', apiKeysRoutes);
api.route('/agents', agentsRoutes);
api.route('/agents', agentSkillsRoutes);
api.route('/agents', agentPoliciesRoutes);
api.route('/agent-runs', agentRunsRoutes);
api.route('/notifications', notificationsRoutes);
api.route('/audit-log', auditLogRoutes);
api.route('/billing', billingRoutes);
api.route('/branding', brandingRoutes);
api.route('/entitlements', entitlementsRoutes);
api.route('/usage', usageRoutes);
api.route('/webhooks', webhooksRoutes);
api.route('/events', eventsRoutes);
api.route('/files', filesRoutes);
api.route('/lakehouse', lakehouseRoutes);
api.route('/integrations', integrationsRoutes);
api.route('/integrations', githubIntegrationRoute);
api.route('/conversations', evalsFeedbackRoutes);
api.route('/conversations', conversationsRoutes);
api.route('/conversations', messagesRoutes);
api.route('/evals', evalsRoutes);
api.route('/sessions', sessionsRoutes);
api.route('/users', usersRoutes);
api.route('/workspaces', workspacesRoutes);
api.route('/llm-providers', llmProvidersRoutes);
api.route('/documents', documentsRoutes);
api.route('/tasks', tasksRoutes);
api.route('/plans', plansRoutes);
api.route('/prds', prdsRoutes);
api.route('/milestones', milestonesRoutes);
api.route('/pages', pagesRoutes);

const internalApi = new Hono<AppEnv>();
internalApi.route('/internal', internalRetrieveRoute);
internalApi.route('/internal/evals', internalEvalsRoute);
internalApi.route('/internal/tool-calls', internalToolCallsRoute);
internalApi.route('/internal/knowledge-gaps', internalKnowledgeGapsRoute);
internalApi.route('/internal/tasks', internalTasksRoute);
internalApi.route('/internal/workflows', internalWorkflowsRoute);
internalApi.route('/internal/integrations', internalIntegrationsRoute);
internalApi.route('/internal/guardrails', internalGuardrailsRoute);
internalApi.route('/internal/fairness', internalFairnessRoute);
internalApi.post('/internal/artifacts/notify', handleArtifactNotify);

// ── Mount ─────────────────────────────────────────────────────────────────────
app.route('/api/v1', publicApi);
app.route('/api/v1', internalApi);
app.route('/api/v1', opsApp);   // platform-admin only — isolated from user middleware
app.route('/api/v1', api);

console.log('REGISTERED ROUTES:', api.routes.map(r => `${r.method} ${r.path}`));

export { app };