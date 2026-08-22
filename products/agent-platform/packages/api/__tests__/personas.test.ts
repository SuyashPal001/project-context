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

describe('personasRoutes second outcome image', () => {
    beforeEach(() => vi.clearAllMocks());

    it('stores exampleAssetUrl2/exampleCaption2 on create', async () => {
        dbMock.select.mockReturnValue({
            from: () => ({ where: () => ({ limit: async () => [] }) }),
        });
        let insertedValues: Record<string, unknown> = {};
        dbMock.insert.mockReturnValue({
            values: (values: Record<string, unknown>) => {
                insertedValues = values;
                return { returning: async () => [{ id: 'p1', ...values }] };
            },
        });

        const app = appWithJwt('platform_admin');
        const res = await app.request('/ops/personas', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                slug: 'nova', name: 'Nova', tagline: 'Ships PRDs', basePersonality: 'Focused',
                exampleAssetUrl2: 'https://example.com/roadmap.png',
                exampleCaption2: 'Sprint Roadmap',
            }),
        });

        expect(res.status).toBe(201);
        expect(insertedValues.exampleAssetUrl2).toBe('https://example.com/roadmap.png');
        expect(insertedValues.exampleCaption2).toBe('Sprint Roadmap');
    });

    it('updates exampleAssetUrl2/exampleCaption2 on a draft persona', async () => {
        dbMock.select.mockReturnValue({
            from: () => ({ where: () => ({ limit: async () => [{ id: 'p1', status: 'draft' }] }) }),
        });
        let setValues: Record<string, unknown> = {};
        dbMock.update.mockReturnValue({
            set: (values: Record<string, unknown>) => {
                setValues = values;
                return { where: () => ({ returning: async () => [{ id: 'p1', ...values }] }) };
            },
        });

        const app = appWithJwt('platform_admin');
        const res = await app.request('/ops/personas/p1', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                exampleAssetUrl2: 'https://example.com/roadmap.png',
                exampleCaption2: 'Sprint Roadmap',
            }),
        });

        expect(res.status).toBe(200);
        expect(setValues.exampleAssetUrl2).toBe('https://example.com/roadmap.png');
        expect(setValues.exampleCaption2).toBe('Sprint Roadmap');
    });
});

describe('personasRoutes publish', () => {
    beforeEach(() => vi.clearAllMocks());

    it('rejects publishing a persona missing a preview image', async () => {
        dbMock.select.mockReturnValue({
            from: () => ({
                where: () => ({
                    limit: async () => [{ id: 'p1', exampleAssetUrl: null }],
                }),
            }),
        });

        const app = appWithJwt('platform_admin');
        const res = await app.request('/ops/personas/p1/publish', { method: 'POST' });
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.code).toBe('INCOMPLETE_ASSETS');
    });

    it('allows publishing a persona with a preview image present', async () => {
        dbMock.select.mockReturnValue({
            from: () => ({
                where: () => ({
                    limit: async () => [{ id: 'p1', exampleAssetUrl: 'https://example.com/preview.png', status: 'draft' }],
                }),
            }),
        });
        dbMock.update.mockReturnValue({
            set: () => ({
                where: () => ({
                    returning: async () => [{ id: 'p1', status: 'published', exampleAssetUrl: 'https://example.com/preview.png' }],
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
