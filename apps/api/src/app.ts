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
import { eventsRoutes } from './routes/events';
import { integrationsRoutes, googleOAuthCallbackRoute, zohoOAuthCallbackRoute, jiraOAuthCallbackRoute } from './routes/integrations';
import { githubIntegrationRoute } from './routes/integrations.github';
import { githubCallbackRoute } from './routes/integrations.github.callback';
import { githubWebhookRoute } from './routes/integrations.github.webhook';
import { usageRecordingMiddleware } from './middleware/usageRecording';
import { sessionsRoutes } from './routes/sessions';
import { usersRoutes } from './routes/users';
import { workspacesRoutes } from './routes/workspaces';
import internalIntegrationsRoute from './routes/internal/integrations';
import { agentProduct } from '@serverless-saas/agent-api';
import { randomUUID } from 'crypto';
import { initCognito } from '@serverless-saas/auth';
import { getCacheClient } from '@serverless-saas/cache';

initCognito({
    region:     process.env.AWS_REGION ?? 'ap-south-1',
    userPoolId: process.env.COGNITO_USER_POOL_ID!,
    clientId:   process.env.COGNITO_CLIENT_ID!,
});

const app = new Hono<AppEnv>();

app.use('*', cors());

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
publicApi.route('/integrations', googleOAuthCallbackRoute);
publicApi.route('/integrations', zohoOAuthCallbackRoute);
publicApi.route('/integrations', jiraOAuthCallbackRoute);
publicApi.route('/integrations', githubCallbackRoute);
publicApi.route('/integrations', githubWebhookRoute);
agentProduct.mountPublicRoutes(publicApi);

const api = new Hono<AppEnv>();

// ── Middleware chain ──────────────────────────────────────────────────────────

api.use('*', authInjectionMiddleware);

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

api.use('*', userUpsertMiddleware);

api.route('/onboarding', onboardingRoutes);
api.route('/invitations', invitationsPublicRoutes);
api.route('/tenants', tenantsRoutes);

api.use('*', apiKeyAuthMiddleware);

// ── Secure middleware ─────────────────────────────────────────────────────────
api.use('*', tenantResolutionMiddleware);
api.use('*', except(['/auth/me', '/auth/tenants'], sessionValidationMiddleware));
api.use('*', entitlementsMiddleware);
api.use('*', permissionsMiddleware);
api.use('*', queryScopeMiddleware);
api.use('*', usageRecordingMiddleware);

// ── Secure foundation routes ──────────────────────────────────────────────────
api.route('/auth', authRoutes);
api.route('/members', membersRoutes);
api.route('/members', memberInviteRoutes);
api.route('/roles', rolesRoutes);
api.route('/api-keys', apiKeysRoutes);
api.route('/notifications', notificationsRoutes);
api.route('/audit-log', auditLogRoutes);
api.route('/billing', billingRoutes);
api.route('/branding', brandingRoutes);
api.route('/entitlements', entitlementsRoutes);
api.route('/usage', usageRoutes);
api.route('/webhooks', webhooksRoutes);
api.route('/events', eventsRoutes);
api.route('/files', filesRoutes);
api.route('/integrations', integrationsRoutes);
api.route('/integrations', githubIntegrationRoute);
api.route('/sessions', sessionsRoutes);
api.route('/users', usersRoutes);
api.route('/workspaces', workspacesRoutes);

// ── Secure product routes (agent-platform) ────────────────────────────────────
agentProduct.mountApiRoutes(api);

const internalApi = new Hono<AppEnv>();
internalApi.route('/internal/integrations', internalIntegrationsRoute);
agentProduct.mountInternalRoutes(internalApi);

// ── Mount ─────────────────────────────────────────────────────────────────────
app.route('/api/v1', publicApi);
app.route('/api/v1', internalApi);
app.route('/api/v1', opsApp);
app.route('/api/v1', api);

console.log('REGISTERED ROUTES:', api.routes.map(r => `${r.method} ${r.path}`));

export { app };
