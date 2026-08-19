import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { handoverPacks, packSections } from '@serverless-saas/agent-schema/handover';

const dbMock = vi.hoisted(() => ({
    select: vi.fn(),
}));

vi.mock('../db', () => ({ db: dbMock }));

const generateMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/handover-generate', () => ({ generateDeliveredItems: generateMock }));

function appWithContext() {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
        c.set('requestContext', {
            tenant: { id: 'tenant-1' },
            permissions: [{ resource: 'handover_packs', action: 'update' }, { resource: 'handover_packs', action: 'read' }],
        });
        c.set('userId', 'user-1');
        c.set('traceId', 'trace-1');
        await next();
    });
    return app;
}

describe('POST /handover/packs/:packId/sync', () => {
    beforeEach(() => vi.clearAllMocks());

    it('re-runs generation against the delivered section and reports how many items were added', async () => {
        dbMock.select.mockImplementation(() => ({
            from: (table: unknown) => {
                if (table === handoverPacks) {
                    return { where: () => ({ limit: async () => [{ id: 'pack-1', tenantId: 'tenant-1', planId: 'plan-1', status: 'draft', deletedAt: null }] }) };
                }
                if (table === packSections) {
                    return { where: () => ({ limit: async () => [{ id: 'section-1' }] }) };
                }
                throw new Error('unexpected select target');
            },
        }));
        generateMock.mockResolvedValue(2);

        const { handoverRoutes } = await import('../routes/handover');
        const app = appWithContext();
        app.route('/handover', handoverRoutes);

        const res = await app.request('/handover/packs/pack-1/sync', { method: 'POST' });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.added).toBe(2);
        expect(generateMock).toHaveBeenCalledWith('tenant-1', 'plan-1', 'pack-1', 'section-1');
    });

    it('refuses to sync a signed pack', async () => {
        dbMock.select.mockImplementation(() => ({
            from: (table: unknown) => {
                if (table === handoverPacks) {
                    return { where: () => ({ limit: async () => [{ id: 'pack-1', tenantId: 'tenant-1', planId: 'plan-1', status: 'signed', deletedAt: null }] }) };
                }
                throw new Error('unexpected select target');
            },
        }));

        const { handoverRoutes } = await import('../routes/handover');
        const app = appWithContext();
        app.route('/handover', handoverRoutes);

        const res = await app.request('/handover/packs/pack-1/sync', { method: 'POST' });

        expect(res.status).toBe(409);
        expect(generateMock).not.toHaveBeenCalled();
    });

    it('returns added: 0 without calling generation when the pack has no delivered section', async () => {
        dbMock.select.mockImplementation(() => ({
            from: (table: unknown) => {
                if (table === handoverPacks) {
                    return { where: () => ({ limit: async () => [{ id: 'pack-1', tenantId: 'tenant-1', planId: 'plan-1', status: 'draft', deletedAt: null }] }) };
                }
                if (table === packSections) {
                    return { where: () => ({ limit: async () => [] }) };
                }
                throw new Error('unexpected select target');
            },
        }));

        const { handoverRoutes } = await import('../routes/handover');
        const app = appWithContext();
        app.route('/handover', handoverRoutes);

        const res = await app.request('/handover/packs/pack-1/sync', { method: 'POST' });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.added).toBe(0);
        expect(generateMock).not.toHaveBeenCalled();
    });
});
