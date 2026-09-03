import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@serverless-saas/credits', () => {
    class InsufficientCreditsError extends Error {
        code = 'INSUFFICIENT_CREDITS';
        constructor(message = 'Insufficient credits') {
            super(message);
            this.name = 'InsufficientCreditsError';
        }
    }
    return {
        getBalance: vi.fn(),
        getLedger: vi.fn(),
        resolveRate: vi.fn(),
        costMicro: vi.fn(),
        grantCredits: vi.fn(),
        InsufficientCreditsError,
    };
});

import { creditsRoutes } from '../credits';
import {
    getBalance,
    getLedger,
    resolveRate,
    costMicro,
    grantCredits,
    InsufficientCreditsError,
} from '@serverless-saas/credits';

const TENANT = 'tenant-credits-1';
const OTHER_TENANT = 'tenant-credits-2';

function appWith(requestContext: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const app = new Hono();
    app.use('*', async (c, next) => {
        c.set('requestContext' as never, requestContext as never);
        c.set('userId' as never, (extra.userId ?? 'user-1') as never);
        c.set('actorType' as never, (extra.actorType ?? 'human') as never);
        await next();
    });
    app.route('/credits', creditsRoutes);
    return app;
}

const readCtx = { tenant: { id: TENANT }, permissions: ['credits:read'] };
const createCtx = { tenant: { id: TENANT }, permissions: ['credits:create'] };
const noPermsCtx = { tenant: { id: TENANT }, permissions: [] };

beforeEach(() => {
    vi.mocked(getBalance).mockReset();
    vi.mocked(getLedger).mockReset();
    vi.mocked(resolveRate).mockReset();
    vi.mocked(costMicro).mockReset();
    vi.mocked(grantCredits).mockReset();
});

describe('GET /credits/balance', () => {
    it('serializes micro amounts as strings, never as BigInt', async () => {
        vi.mocked(getBalance).mockResolvedValue({
            balanceMicro: 12345678901234n,
            unlimited: false,
            grants: [],
        });

        const app = appWith(readCtx);
        const res = await app.request('/credits/balance');
        const body = await res.json() as any;

        expect(res.status).toBe(200);
        expect(typeof body.balanceMicro).toBe('string');
        expect(body.balanceMicro).toBe('12345678901234');
    });

    it('returns 403 without credits:read', async () => {
        const app = appWith(noPermsCtx);
        const res = await app.request('/credits/balance');
        expect(res.status).toBe(403);
        expect(getBalance).not.toHaveBeenCalled();
    });

    it('reports unlimited: true with no balance figure for unlimited tenants', async () => {
        vi.mocked(getBalance).mockResolvedValue({
            balanceMicro: 0n,
            unlimited: true,
            grants: [],
        });

        const app = appWith(readCtx);
        const res = await app.request('/credits/balance');
        const body = await res.json() as any;

        expect(body).toEqual({ unlimited: true });
        expect(body.balanceMicro).toBeUndefined();
    });

    it('scopes the balance lookup to the caller tenant, not a user-supplied one', async () => {
        vi.mocked(getBalance).mockResolvedValue({ balanceMicro: 1n, unlimited: false, grants: [] });

        const app = appWith(readCtx);
        await app.request('/credits/balance?tenantId=' + OTHER_TENANT);

        expect(getBalance).toHaveBeenCalledWith(TENANT);
        expect(getBalance).not.toHaveBeenCalledWith(OTHER_TENANT);
    });

    it('serializes grant amounts as strings too', async () => {
        vi.mocked(getBalance).mockResolvedValue({
            balanceMicro: 500n,
            unlimited: false,
            grants: [{ grantType: 'purchase', amountMicro: 1000n, spentMicro: 500n, expiresAt: null }],
        });

        const app = appWith(readCtx);
        const res = await app.request('/credits/balance');
        const body = await res.json() as any;

        expect(body.grants[0].amountMicro).toBe('1000');
        expect(body.grants[0].spentMicro).toBe('500');
    });
});

describe('GET /credits/estimate', () => {
    it('returns cost, balance, sufficiency, and the rate it used', async () => {
        vi.mocked(resolveRate).mockResolvedValue({
            id: 'rate-1',
            version: 3,
            schema: { per_message_micro: 100 },
        });
        vi.mocked(costMicro).mockReturnValue(100n);
        vi.mocked(getBalance).mockResolvedValue({ balanceMicro: 1000n, unlimited: false, grants: [] });

        const app = appWith(readCtx);
        const res = await app.request('/credits/estimate?resourceType=message&subject=*&count=1');
        const body = await res.json() as any;

        expect(res.status).toBe(200);
        expect(body).toHaveProperty('costMicro', '100');
        expect(body).toHaveProperty('rateId', 'rate-1');
        expect(body).toHaveProperty('rateVersion', 3);
        expect(body.sufficient).toBe(true);
    });

    it('never writes a ledger row - the estimate is a preview', async () => {
        vi.mocked(resolveRate).mockResolvedValue({
            id: 'rate-1',
            version: 1,
            schema: { per_message_micro: 100 },
        });
        vi.mocked(costMicro).mockReturnValue(100n);
        vi.mocked(getBalance).mockResolvedValue({ balanceMicro: 1000n, unlimited: false, grants: [] });

        const app = appWith(readCtx);
        await app.request('/credits/estimate?resourceType=message&subject=*&count=1');

        expect(grantCredits).not.toHaveBeenCalled();
    });

    it('returns 403 without credits:read', async () => {
        const app = appWith(noPermsCtx);
        const res = await app.request('/credits/estimate?resourceType=message&subject=*&count=1');
        expect(res.status).toBe(403);
        expect(resolveRate).not.toHaveBeenCalled();
    });

    it('accepts image_generation as a valid resourceType', async () => {
        vi.mocked(resolveRate).mockResolvedValue({
            id: 'rate-1',
            version: 1,
            schema: { per_call_micro: 100 },
        });
        vi.mocked(costMicro).mockReturnValue(100n);
        vi.mocked(getBalance).mockResolvedValue({ balanceMicro: 1000n, unlimited: false, grants: [] });

        const app = appWith(readCtx);
        const res = await app.request('/credits/estimate?resourceType=image_generation&subject=gemini-3-pro-image-preview&count=1');

        expect(res.status).not.toBe(400);
    });

    it('reports insufficient when cost exceeds balance', async () => {
        vi.mocked(resolveRate).mockResolvedValue({
            id: 'rate-1',
            version: 1,
            schema: { per_message_micro: 5000 },
        });
        vi.mocked(costMicro).mockReturnValue(5000n);
        vi.mocked(getBalance).mockResolvedValue({ balanceMicro: 10n, unlimited: false, grants: [] });

        const app = appWith(readCtx);
        const res = await app.request('/credits/estimate?resourceType=message&subject=*&count=1');
        const body = await res.json() as any;

        expect(body.sufficient).toBe(false);
    });

    it('returns 404 when no rate resolves', async () => {
        vi.mocked(resolveRate).mockResolvedValue(null);

        const app = appWith(readCtx);
        const res = await app.request('/credits/estimate?resourceType=message&subject=*&count=1');
        expect(res.status).toBe(404);
    });

    it('returns 400 for a non-numeric count instead of NaN reaching costMicro', async () => {
        const app = appWith(readCtx);
        const res = await app.request('/credits/estimate?resourceType=message&subject=*&count=abc');
        expect(res.status).toBe(400);
        expect(resolveRate).not.toHaveBeenCalled();
        expect(costMicro).not.toHaveBeenCalled();
    });

    it('returns 400 for a non-numeric inputTokens', async () => {
        const app = appWith(readCtx);
        const res = await app.request('/credits/estimate?resourceType=llm_tokens&subject=*&inputTokens=abc');
        expect(res.status).toBe(400);
        expect(costMicro).not.toHaveBeenCalled();
    });

    it('returns 400 for a non-numeric outputTokens', async () => {
        const app = appWith(readCtx);
        const res = await app.request('/credits/estimate?resourceType=llm_tokens&subject=*&outputTokens=abc');
        expect(res.status).toBe(400);
        expect(costMicro).not.toHaveBeenCalled();
    });

    it('defaults count to 1 rather than 0 when omitted, so an unmetered call is never reported free', async () => {
        vi.mocked(resolveRate).mockResolvedValue({
            id: 'rate-1',
            version: 1,
            schema: { per_message_micro: 250 },
        });
        vi.mocked(costMicro).mockReturnValue(250n);
        vi.mocked(getBalance).mockResolvedValue({ balanceMicro: 1000n, unlimited: false, grants: [] });

        const app = appWith(readCtx);
        await app.request('/credits/estimate?resourceType=message&subject=*');

        expect(costMicro).toHaveBeenCalledWith(
            { per_message_micro: 250 },
            expect.objectContaining({ count: 1 }),
        );
    });

    it('scopes the estimate lookup to the caller tenant, ignoring a user-supplied tenantId', async () => {
        vi.mocked(resolveRate).mockResolvedValue({
            id: 'rate-1',
            version: 1,
            schema: { per_message_micro: 100 },
        });
        vi.mocked(costMicro).mockReturnValue(100n);
        vi.mocked(getBalance).mockResolvedValue({ balanceMicro: 1000n, unlimited: false, grants: [] });

        const app = appWith(readCtx);
        await app.request(`/credits/estimate?resourceType=message&subject=*&count=1&tenantId=${OTHER_TENANT}`);

        expect(getBalance).toHaveBeenCalledWith(TENANT);
        expect(getBalance).not.toHaveBeenCalledWith(OTHER_TENANT);
    });
});

describe('GET /credits/ledger', () => {
    it('returns ledger rows with micro amounts serialized as strings', async () => {
        vi.mocked(getLedger).mockResolvedValue([
            {
                id: 'row-1',
                tenantId: TENANT,
                actorId: null,
                actorType: null,
                grantId: null,
                kind: 'debit',
                amountMicro: -500n,
                balanceAfterMicro: 9500n,
                jobId: null,
                jobType: null,
                rateId: null,
                rateVersion: null,
                idempotencyKey: 'k1',
                seq: 0,
                reason: null,
                createdAt: new Date('2026-01-01T00:00:00Z'),
            },
        ] as never);

        const app = appWith(readCtx);
        const res = await app.request('/credits/ledger');
        const body = await res.json() as any;

        expect(res.status).toBe(200);
        expect(body.data[0].amountMicro).toBe('-500');
        expect(body.data[0].balanceAfterMicro).toBe('9500');
    });

    it('returns 403 without credits:read', async () => {
        const app = appWith(noPermsCtx);
        const res = await app.request('/credits/ledger');
        expect(res.status).toBe(403);
        expect(getLedger).not.toHaveBeenCalled();
    });

    it('scopes the ledger lookup to the caller tenant, ignoring a user-supplied tenantId', async () => {
        vi.mocked(getLedger).mockResolvedValue([]);
        const app = appWith(readCtx);
        await app.request(`/credits/ledger?tenantId=${OTHER_TENANT}`);
        expect(getLedger).toHaveBeenCalledWith(TENANT, expect.any(Object));
        expect(getLedger).not.toHaveBeenCalledWith(OTHER_TENANT, expect.anything());
    });

    it('forwards limit, before, and kind verbatim - not just "some object"', async () => {
        vi.mocked(getLedger).mockResolvedValue([]);
        const app = appWith(readCtx);
        await app.request('/credits/ledger?limit=25&before=2026-01-01T00:00:00.000Z&kind=debit');

        expect(getLedger).toHaveBeenCalledWith(TENANT, {
            limit: 25,
            before: new Date('2026-01-01T00:00:00.000Z'),
            kind: 'debit',
        });
    });

    it('returns 400 for a non-numeric limit', async () => {
        const app = appWith(readCtx);
        const res = await app.request('/credits/ledger?limit=abc');
        expect(res.status).toBe(400);
        expect(getLedger).not.toHaveBeenCalled();
    });

    it('returns 400 for an unparsable before date', async () => {
        const app = appWith(readCtx);
        const res = await app.request('/credits/ledger?before=garbage');
        expect(res.status).toBe(400);
        expect(getLedger).not.toHaveBeenCalled();
    });

    it('returns 400 for a kind outside the ledger enum', async () => {
        const app = appWith(readCtx);
        const res = await app.request('/credits/ledger?kind=nonsense');
        expect(res.status).toBe(400);
        expect(getLedger).not.toHaveBeenCalled();
    });
});

describe('POST /credits/grants', () => {
    const validBody = {
        amountMicro: '1000000',
        grantType: 'admin',
        key: 'grant-key-1',
    };

    it('returns 403 without credits:create', async () => {
        const app = appWith(readCtx); // has credits:read, not credits:create
        const res = await app.request('/credits/grants', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(validBody),
        });
        expect(res.status).toBe(403);
        expect(grantCredits).not.toHaveBeenCalled();
    });

    it('grants credits and serializes the resulting balance as a string', async () => {
        vi.mocked(grantCredits).mockResolvedValue(1000000n);

        const app = appWith(createCtx);
        const res = await app.request('/credits/grants', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(validBody),
        });
        const body = await res.json() as any;

        expect(res.status).toBe(200);
        expect(body.balanceMicro).toBe('1000000');
        expect(grantCredits).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: TENANT,
            amountMicro: 1000000n,
            key: 'grant-key-1',
            grantType: 'admin',
        }));
    });

    it('passes the caller-supplied idempotency key straight through', async () => {
        vi.mocked(grantCredits).mockResolvedValue(1n);

        const app = appWith(createCtx);
        await app.request('/credits/grants', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...validBody, key: 'my-idempotency-key-42' }),
        });

        expect(grantCredits).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'my-idempotency-key-42' }),
        );
    });

    it('rejects a non-positive amountMicro', async () => {
        const app = appWith(createCtx);
        const res = await app.request('/credits/grants', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...validBody, amountMicro: '0' }),
        });
        expect(res.status).toBe(400);
        expect(grantCredits).not.toHaveBeenCalled();
    });

    it('maps InsufficientCreditsError to 402', async () => {
        vi.mocked(grantCredits).mockRejectedValue(new InsufficientCreditsError());

        const app = appWith(createCtx);
        const res = await app.request('/credits/grants', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(validBody),
        });

        expect(res.status).toBe(402);
    });

    it('scopes the grant to the caller tenant, ignoring a body-supplied tenantId', async () => {
        vi.mocked(grantCredits).mockResolvedValue(1n);

        const app = appWith(createCtx);
        await app.request('/credits/grants', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...validBody, tenantId: OTHER_TENANT }),
        });

        expect(grantCredits).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT }));
        expect(grantCredits).not.toHaveBeenCalledWith(expect.objectContaining({ tenantId: OTHER_TENANT }));
    });
});
