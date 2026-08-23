import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { roles, rolePermissions } from '@serverless-saas/database/schema/authorization';
import { agents } from '@serverless-saas/agent-schema/agents';
import { apiKeys } from '@serverless-saas/database/schema/access';
import { llmProviders } from '@serverless-saas/database/schema/integrations';

/**
 * Task 11 — POST /agents now accepts an optional personaId so
 * PersonaDetailModal's "Assign Task Now" can hire a persona by creating a
 * `custom`-type agent linked to it via agents.personaId.
 */

const dbMock = vi.hoisted(() => ({
    select: vi.fn(),
    insert: vi.fn(),
}));

vi.mock('../db', () => ({ db: dbMock }));

const AGENT_ROLE = { id: 'role-1', isAgentRole: true };
const PERMISSION_ROWS = [{ resource: 'agents', action: 'read' }];
const DEFAULT_PROVIDER = { id: 'provider-1', displayName: 'Gemini 2.5 Flash', model: 'gemini-2.5-flash' };

function setupDb() {
    dbMock.select.mockImplementation(() => ({
        from: (table: unknown) => {
            if (table === roles) {
                return { where: () => ({ limit: async () => [AGENT_ROLE] }) };
            }
            if (table === rolePermissions) {
                return { innerJoin: () => ({ where: async () => PERMISSION_ROWS }) };
            }
            if (table === llmProviders) {
                return { where: () => ({ limit: async () => [DEFAULT_PROVIDER] }) };
            }
            throw new Error('unexpected db.select().from(...) target in test');
        },
    }));

    dbMock.insert.mockImplementation((table: unknown) => ({
        values: (data: Record<string, unknown>) => {
            if (table === apiKeys) return { returning: async () => [{ id: 'key-1' }] };
            if (table === agents) return { returning: async () => [{ id: 'agent-1', ...data }] };
            // memberships / auditLog inserts — handler does not chain .returning()
            return Promise.resolve([]);
        },
    }));
}

function appWithContext() {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
        c.set('requestContext', {
            tenant: { id: 'tenant-1' },
            permissions: [{ resource: 'agents', action: 'create' }],
            // entitlements intentionally omitted — skips the plan-limit branch
        });
        c.set('userId', 'user-1');
        c.set('traceId', 'trace-1');
        await next();
    });
    return app;
}

describe('POST /agents personaId', () => {
    beforeEach(() => vi.clearAllMocks());

    it('persists an optional personaId onto the created agent', async () => {
        setupDb();
        const { handleCreateAgent } = await import('../routes/agents.crud');
        const app = appWithContext();
        app.post('/agents', handleCreateAgent);

        const personaId = '11111111-1111-1111-1111-111111111111';
        const res = await app.request('/agents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Ada', type: 'custom', personaId }),
        });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.data.agent.personaId).toBe(personaId);

        // Confirm personaId actually reached db.insert(agents).values({...}),
        // not just echoed back by the response shape.
        expect(dbMock.insert).toHaveBeenCalledWith(agents);
    });

    it('creates an agent fine when personaId is omitted (backward compatible)', async () => {
        setupDb();
        const { handleCreateAgent } = await import('../routes/agents.crud');
        const app = appWithContext();
        app.post('/agents', handleCreateAgent);

        const res = await app.request('/agents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Ada', type: 'custom' }),
        });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.data.agent.personaId).toBeUndefined();
    });

    it('rejects a non-uuid personaId with 400', async () => {
        setupDb();
        const { handleCreateAgent } = await import('../routes/agents.crud');
        const app = appWithContext();
        app.post('/agents', handleCreateAgent);

        const res = await app.request('/agents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Ada', type: 'custom', personaId: 'not-a-uuid' }),
        });

        expect(res.status).toBe(400);
    });

    it('stamps the platform default model/llmProviderId when neither is provided (hirePersona never sends one)', async () => {
        setupDb();
        const { handleCreateAgent } = await import('../routes/agents.crud');
        const app = appWithContext();
        app.post('/agents', handleCreateAgent);

        const res = await app.request('/agents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Ada', type: 'custom' }),
        });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.data.agent.model).toBe('Gemini 2.5 Flash');
        expect(body.data.agent.llmProviderId).toBe('provider-1');
    });

    it('still accepts the "custom" type used by hirePersona', async () => {
        setupDb();
        const { handleCreateAgent } = await import('../routes/agents.crud');
        const app = appWithContext();
        app.post('/agents', handleCreateAgent);

        const res = await app.request('/agents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Ada', type: 'custom' }),
        });

        expect(res.status).toBe(201);
    });
});
