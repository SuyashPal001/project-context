import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@serverless-saas/database';
import { users } from '@serverless-saas/database/schema/auth';
import { getCacheClient } from '@serverless-saas/cache';
import { adminInitiateAuth, getUserProvider } from '@serverless-saas/auth';
import type { AppEnv } from '../types';

export const authPublicRoutes = new Hono<AppEnv>();

// POST /auth/login
authPublicRoutes.post('/login', async (c) => {
    const body = await c.req.json();
    const { email, password } = body;

    if (!email || !password) return c.json({ error: 'Email and password are required' }, 400);

    try {
        const result = await adminInitiateAuth(email, password);

        if (result.ChallengeName) {
            return c.json({ challenge: result.ChallengeName, session: result.Session, parameters: result.ChallengeParameters });
        }

        return c.json({
            token: result.AuthenticationResult?.IdToken,
            accessToken: result.AuthenticationResult?.AccessToken,
            refreshToken: result.AuthenticationResult?.RefreshToken,
            expiresIn: result.AuthenticationResult?.ExpiresIn,
        });
    } catch (err: any) {
        console.error('Login error:', err);
        return c.json({ error: err.message || 'Authentication failed', code: err.name || 'INTERNAL_ERROR' }, 401);
    }
});

// GET /auth/check-email?email=xxx
authPublicRoutes.get('/check-email', async (c) => {
    const email = c.req.query('email');
    if (!email) return c.json({ error: 'Email is required' }, 400);

    const result = z.string().email().safeParse(email);
    if (!result.success) return c.json({ error: 'Invalid email format' }, 400);

    const validatedEmail = result.data;
    const cacheClient = await getCacheClient();
    const rateLimitKey = `ratelimit:check-email:${validatedEmail.toLowerCase()}`;
    const requestCount = await cacheClient.incr(rateLimitKey);

    if (requestCount === 1) await cacheClient.expire(rateLimitKey, 60);

    if (requestCount > 5) {
        return c.json({ error: 'Too many requests. Please try again later.', code: 'RATE_LIMIT_EXCEEDED', retryAfter: 60 }, 429);
    }

    const cognitoProvider = await getUserProvider(validatedEmail).catch(() => 'not_found' as const);

    if (cognitoProvider !== 'not_found') {
        return c.json({ exists: true, provider: cognitoProvider });
    }

    const [user] = await db
        .select({ id: users.id }).from(users)
        .where(and(eq(users.email, validatedEmail), isNull(users.deletedAt)))
        .limit(1);

    return c.json({ exists: !!user, provider: 'not_found' });
});
