import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@serverless-saas/credits', () => ({
    listActivePacks: vi.fn(),
    grantCredits: vi.fn(),
    MICRO_PER_CREDIT: 1_000_000n,
}));

const insertValues = vi.fn().mockResolvedValue(undefined);
vi.mock('@serverless-saas/database', () => ({
    db: {
        insert: vi.fn(() => ({ values: insertValues })),
    },
}));

import { billingRoutes } from '../billing';
import { listActivePacks, grantCredits } from '@serverless-saas/credits';

const TENANT = 'tenant-billing-1';

function appWith(requestContext: Record<string, unknown>) {
    const app = new Hono();
    app.use('*', async (c, next) => {
        c.set('requestContext' as never, requestContext as never);
        c.set('userId' as never, 'user-1' as never);
        await next();
    });
    app.route('/billing', billingRoutes);
    return app;
}

const updateCtx = { tenant: { id: TENANT }, permissions: ['billing:update'] };
const readOnlyCtx = { tenant: { id: TENANT }, permissions: ['billing:read'] };

const BULK_PACK = {
    id: 'pack-bulk', key: 'bulk', name: 'Bulk pack', credits: 5000,
    priceCents: 10000, currency: 'usd', isActive: true, sortOrder: 3, createdAt: new Date(),
};

beforeEach(() => {
    vi.mocked(listActivePacks).mockReset();
    vi.mocked(grantCredits).mockReset();
    insertValues.mockClear();
});

describe('POST /billing/credits/topup', () => {
    it('grants the pack\'s credits as a purchase, server-computed from the pack row', async () => {
        vi.mocked(listActivePacks).mockResolvedValue([BULK_PACK] as never);
        vi.mocked(grantCredits).mockResolvedValue(5_000_000_000n);

        const app = appWith(updateCtx);
        const res = await app.request('/billing/credits/topup', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ packKey: 'bulk' }),
        });
        const body = await res.json() as any;

        expect(res.status).toBe(200);
        expect(body.balanceMicro).toBe('5000000000');
        expect(grantCredits).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: TENANT,
            amountMicro: 5_000_000_000n,
            grantType: 'purchase',
        }));
    });

    it('returns 404 for a packKey that is not an active pack', async () => {
        vi.mocked(listActivePacks).mockResolvedValue([BULK_PACK] as never);

        const app = appWith(updateCtx);
        const res = await app.request('/billing/credits/topup', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ packKey: 'retired-pack' }),
        });

        expect(res.status).toBe(404);
        expect(grantCredits).not.toHaveBeenCalled();
    });

    it('returns 403 without billing:update', async () => {
        const app = appWith(readOnlyCtx);
        const res = await app.request('/billing/credits/topup', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ packKey: 'bulk' }),
        });

        expect(res.status).toBe(403);
        expect(listActivePacks).not.toHaveBeenCalled();
    });

    it('rejects a missing packKey', async () => {
        const app = appWith(updateCtx);
        const res = await app.request('/billing/credits/topup', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
        });

        expect(res.status).toBe(400);
        expect(listActivePacks).not.toHaveBeenCalled();
    });
});
