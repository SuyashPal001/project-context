import { Hono } from 'hono';
import type { AppEnv } from './types';
import { authInjectionMiddleware } from './middleware/authInjection';
import { userUpsertMiddleware } from './middleware/userUpsert';
import { opsRoutes } from './routes/ops';
import { agentTemplatesRoutes } from './routes/agentTemplates';

// Separate Hono app for platform-admin ops portal.
// Completely isolated from user middleware chain — ops bugs cannot affect user auth.
export const opsApp = new Hono<AppEnv>();

// JWT extraction only — no user session, no tenant resolution, no entitlements
// MUST use '/ops/*' not '*' — opsApp is mounted before api, so '*' intercepts all /api/v1/* requests
opsApp.use('/ops/*', authInjectionMiddleware);

// Upsert so userId is available for ops actions (e.g. fairness "run by")
opsApp.use('/ops/*', userUpsertMiddleware);

// Hard gate: only platform_admin JWTs reach ops routes
opsApp.use('/ops/*', async (c, next) => {
    const jwtPayload = c.get('jwtPayload') as any;
    if (jwtPayload?.['custom:role'] !== 'platform_admin') {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    return next();
});

opsApp.route('/ops', opsRoutes);
opsApp.route('/ops/agent-templates', agentTemplatesRoutes);
