import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { personasRoutes } from '../routes/personas';

const dbMock = vi.hoisted(() => ({
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
}));

vi.mock('../db', () => ({ db: dbMock }));

function appWithJwt(role: string | null) {
    const app = new Hono();
    app.use('*', async (c, next) => {
        c.set('jwtPayload', role ? { 'custom:role': role } : undefined);
        c.set('userId', 'user-1');
        await next();
    });
    app.route('/ops/personas', personasRoutes);
    return app;
}

describe('personasRoutes auth', () => {
    beforeEach(() => vi.clearAllMocks());

    it('rejects GET / for a non-platform-admin caller', async () => {
        const app = appWithJwt('tenant_owner');
        const res = await app.request('/ops/personas');
        expect(res.status).toBe(403);
    });

    it('rejects POST / for an unauthenticated caller', async () => {
        const app = appWithJwt(null);
        const res = await app.request('/ops/personas', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(403);
    });
});

describe('personasRoutes publish', () => {
    beforeEach(() => vi.clearAllMocks());

    it('rejects publishing a persona missing animation states', async () => {
        dbMock.select.mockReturnValue({
            from: () => ({
                where: () => ({
                    limit: async () => [{ id: 'p1', animationStates: null }],
                }),
            }),
        });

        const app = appWithJwt('platform_admin');
        const res = await app.request('/ops/personas/p1/publish', { method: 'POST' });
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.code).toBe('INCOMPLETE_ASSETS');
    });

    it('rejects publishing a persona with only the old 3-state set (idle/thinking/responding)', async () => {
        dbMock.select.mockReturnValue({
            from: () => ({
                where: () => ({
                    limit: async () => [{
                        id: 'p1',
                        animationStates: {
                            idle: 'https://example.com/idle.png',
                            thinking: 'https://example.com/thinking.png',
                            responding: 'https://example.com/responding.png',
                        },
                    }],
                }),
            }),
        });

        const app = appWithJwt('platform_admin');
        const res = await app.request('/ops/personas/p1/publish', { method: 'POST' });
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.code).toBe('INCOMPLETE_ASSETS');
        expect(body.error).toContain('waving');
    });

    it('allows publishing a persona with all 9 animation states present', async () => {
        const allStates = {
            idle: 'https://example.com/idle.png',
            waving: 'https://example.com/waving.png',
            running: 'https://example.com/running.png',
            thinking: 'https://example.com/thinking.png',
            responding: 'https://example.com/responding.png',
            waiting: 'https://example.com/waiting.png',
            review: 'https://example.com/review.png',
            done: 'https://example.com/done.png',
            failed: 'https://example.com/failed.png',
        };
        dbMock.select.mockReturnValue({
            from: () => ({
                where: () => ({
                    limit: async () => [{ id: 'p1', animationStates: allStates, status: 'draft' }],
                }),
            }),
        });
        dbMock.update.mockReturnValue({
            set: () => ({
                where: () => ({
                    returning: async () => [{ id: 'p1', status: 'published', animationStates: allStates }],
                }),
            }),
        });

        const app = appWithJwt('platform_admin');
        const res = await app.request('/ops/personas/p1/publish', { method: 'POST' });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.persona.status).toBe('published');
    });
});
