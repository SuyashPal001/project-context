import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
    getBalance,
    getLedger,
    resolveRate,
    costMicro,
    grantCredits,
    InsufficientCreditsError,
} from '@serverless-saas/credits';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '../types';

export const creditsRoutes = new Hono<AppEnv>();

const RESOURCE_TYPES = ['llm_tokens', 'message', 'tool_call', 'skill_run', 'image_generation', 'music_generation', 'video_generation'] as const;
const LEDGER_KINDS = ['grant', 'debit', 'refund', 'settle', 'expiry', 'adjust'] as const;

function forbidden(c: Context<AppEnv>) {
    return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
}

function validationFailed(c: Context<AppEnv>, details: unknown) {
    return c.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details }, 400);
}

// GET /credits/balance — current balance for the caller's tenant.
// Unlimited tenants report `unlimited: true` with no balance figure.
creditsRoutes.get('/balance', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'credits', 'read')) {
        return forbidden(c);
    }

    const balance = await getBalance(tenantId);

    if (balance.unlimited) {
        return c.json({ unlimited: true });
    }

    return c.json({
        unlimited: false,
        // Drizzle's bigint mode returns a JS BigInt; JSON.stringify throws on
        // BigInt, so every micro amount below is serialized with String()
        // rather than sent as a number.
        balanceMicro: String(balance.balanceMicro),
        grants: balance.grants.map((g) => ({
            grantType: g.grantType,
            amountMicro: String(g.amountMicro),
            spentMicro: String(g.spentMicro),
            expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
        })),
    });
});

const estimateQuerySchema = z.object({
    resourceType: z.enum(RESOURCE_TYPES),
    subject: z.string().min(1).optional(),
    // Missing count silently estimating zero reads as "free" to a client, so
    // it defaults to 1 rather than 0.
    count: z.coerce.number().int().nonnegative().optional().default(1),
    inputTokens: z.coerce.number().int().nonnegative().optional(),
    outputTokens: z.coerce.number().int().nonnegative().optional(),
});

// GET /credits/estimate — preview the cost of a would-be operation against the
// current rate and current balance. Never locks, never reserves, never writes
// a ledger row: the authoritative check lives inside spend_credits().
creditsRoutes.get('/estimate', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'credits', 'read')) {
        return forbidden(c);
    }

    const parsed = estimateQuerySchema.safeParse({
        resourceType: c.req.query('resourceType'),
        subject: c.req.query('subject'),
        count: c.req.query('count'),
        inputTokens: c.req.query('inputTokens'),
        outputTokens: c.req.query('outputTokens'),
    });
    if (!parsed.success) {
        return validationFailed(c, parsed.error.flatten());
    }
    const { resourceType, subject, count, inputTokens, outputTokens } = parsed.data;

    const rate = await resolveRate(resourceType, subject ?? '*');
    if (!rate) {
        return c.json({ error: 'Rate not found', code: 'RATE_NOT_FOUND' }, 404);
    }

    const costMicroAmount = costMicro(rate.schema, { count, inputTokens, outputTokens });

    const balance = await getBalance(tenantId);

    const body: Record<string, unknown> = {
        costMicro: String(costMicroAmount),
        rateId: rate.id,
        rateVersion: rate.version,
        unlimited: balance.unlimited,
        sufficient: balance.unlimited ? true : balance.balanceMicro >= costMicroAmount,
    };
    if (!balance.unlimited) {
        body.balanceMicro = String(balance.balanceMicro);
    }

    return c.json(body);
});

const ledgerQuerySchema = z.object({
    limit: z.coerce.number().int().nonnegative().optional(),
    before: z.string().datetime().optional(),
    kind: z.enum(LEDGER_KINDS).optional(),
});

// GET /credits/ledger — paginated ledger history for the caller's tenant.
creditsRoutes.get('/ledger', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'credits', 'read')) {
        return forbidden(c);
    }

    const parsed = ledgerQuerySchema.safeParse({
        limit: c.req.query('limit'),
        before: c.req.query('before'),
        kind: c.req.query('kind'),
    });
    if (!parsed.success) {
        return validationFailed(c, parsed.error.flatten());
    }
    const { limit, before, kind } = parsed.data;

    const rows = await getLedger(tenantId, {
        limit,
        before: before ? new Date(before) : undefined,
        kind,
    });

    return c.json({
        data: rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            amountMicro: String(row.amountMicro),
            balanceAfterMicro: String(row.balanceAfterMicro),
            grantId: row.grantId,
            jobId: row.jobId,
            jobType: row.jobType,
            rateId: row.rateId,
            rateVersion: row.rateVersion,
            reason: row.reason,
            createdAt: row.createdAt,
        })),
    });
});

const grantSchema = z.object({
    amountMicro: z.string().refine((v) => {
        try {
            return BigInt(v) > 0n;
        } catch {
            return false;
        }
    }, { message: 'amountMicro must be a positive integer string' }),
    grantType: z.enum(['purchase', 'subscription', 'trial', 'admin', 'refund']),
    key: z.string().min(1),
    expiresAt: z.string().datetime().nullish(),
    reason: z.string().max(500).optional(),
});

// POST /credits/grants — idempotent by the caller-supplied `key`, which passes
// straight through to spend_credits(); the per-tenant unique index on
// (tenant_id, idempotency_key, seq) is what actually enforces the replay.
creditsRoutes.post('/grants', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const userId = c.get('userId') as string | undefined;
    const actorType = (c.get('actorType') as 'human' | 'agent' | undefined) ?? 'human';

    if (!hasPermission(permissions, 'credits', 'create')) {
        return forbidden(c);
    }

    let payload: unknown;
    try {
        payload = await c.req.json();
    } catch {
        return validationFailed(c, 'invalid JSON body');
    }

    const result = grantSchema.safeParse(payload);
    if (!result.success) {
        return validationFailed(c, result.error.flatten());
    }

    try {
        // tenantId always comes from requestContext (the JWT claim), never
        // from the body — grantSchema has no tenantId field, so a caller
        // cannot mint credits into another tenant's account by supplying one.
        const balanceMicro = await grantCredits({
            tenantId,
            amountMicro: BigInt(result.data.amountMicro),
            key: result.data.key,
            grantType: result.data.grantType,
            expiresAt: result.data.expiresAt ? new Date(result.data.expiresAt) : null,
            actorId: userId ?? null,
            actorType,
            reason: result.data.reason ?? null,
        });

        return c.json({ balanceMicro: String(balanceMicro) });
    } catch (err) {
        if (err instanceof InsufficientCreditsError) {
            return c.json({ error: err.message, code: err.code }, 402);
        }
        throw err;
    }
});
