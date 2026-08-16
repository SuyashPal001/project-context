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
});
