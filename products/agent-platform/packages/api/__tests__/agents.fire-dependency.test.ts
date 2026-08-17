import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { agents } from '@serverless-saas/agent-schema/agents';
import { agentWorkflows } from '@serverless-saas/agent-schema/agents';
import { apiKeys } from '@serverless-saas/database/schema/access';

const dbMock = vi.hoisted(() => ({
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
}));

vi.mock('../db', () => ({ db: dbMock }));

const EXISTING_AGENT = { id: 'agent-1', tenantId: 'tenant-1', apiKeyId: 'key-1', status: 'active' };

function setupDb(opts: { workflowCount: number }) {
    dbMock.select.mockImplementation(() => ({
        from: (table: unknown) => {
            if (table === agents) {
                return { where: () => ({ limit: async () => [EXISTING_AGENT] }) };
            }
            if (table === agentWorkflows) {
                return { where: async () => [{ value: opts.workflowCount }] };
            }
            throw new Error('unexpected db.select().from(...) target in test');
        },
    }));

    dbMock.update.mockImplementation(() => ({
        set: () => ({ where: () => ({ returning: async () => [{ ...EXISTING_AGENT, status: 'retired' }] }) }),
    }));

    dbMock.insert.mockImplementation(() => ({
        values: () => Promise.resolve([]),
    }));
}

function appWithContext() {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
        c.set('requestContext', {
            tenant: { id: 'tenant-1' },
            permissions: [{ resource: 'agents', action: 'delete' }],
        });
        c.set('userId', 'user-1');
        c.set('traceId', 'trace-1');
        await next();
    });
    return app;
}

describe('DELETE /agents/:id — fire dependency check', () => {
    beforeEach(() => vi.clearAllMocks());

    it('blocks firing with 409 when the agent has active shifts (agentWorkflows)', async () => {
        setupDb({ workflowCount: 2 });
        const { handleDeleteAgent } = await import('../routes/agents.crud');
        const app = appWithContext();
        app.delete('/agents/:id', handleDeleteAgent);

        const res = await app.request('/agents/agent-1', { method: 'DELETE' });

        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.shiftsCount).toBe(2);
        expect(body.teamsCount).toBe(0);
        expect(dbMock.update).not.toHaveBeenCalled();
    });

    it('fires anyway when force:true is sent, bypassing the dependency check', async () => {
        setupDb({ workflowCount: 2 });
        const { handleDeleteAgent } = await import('../routes/agents.crud');
        const app = appWithContext();
        app.delete('/agents/:id', handleDeleteAgent);

        const res = await app.request('/agents/agent-1', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force: true }),
        });

        expect(res.status).toBe(200);
        expect(dbMock.update).toHaveBeenCalled();
    });

    it('fires with no dependency check needed when shiftsCount is 0', async () => {
        setupDb({ workflowCount: 0 });
        const { handleDeleteAgent } = await import('../routes/agents.crud');
        const app = appWithContext();
        app.delete('/agents/:id', handleDeleteAgent);

        const res = await app.request('/agents/agent-1', { method: 'DELETE' });

        expect(res.status).toBe(200);
        expect(dbMock.update).toHaveBeenCalled();
    });
});

function appWithUpdateContext() {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
        c.set('requestContext', {
            tenant: { id: 'tenant-1' },
            permissions: [{ resource: 'agents', action: 'update' }],
        });
        c.set('userId', 'user-1');
        c.set('traceId', 'trace-1');
        await next();
    });
    return app;
}

describe('PATCH /agents/:id — retiring via status update is also dependency-checked', () => {
    beforeEach(() => vi.clearAllMocks());

    it('blocks status:retired with 409 when the agent has active shifts, same as DELETE', async () => {
        setupDb({ workflowCount: 3 });
        const { handleUpdateAgent } = await import('../routes/agents.crud');
        const app = appWithUpdateContext();
        app.patch('/agents/:id', handleUpdateAgent);

        const res = await app.request('/agents/agent-1', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'retired' }),
        });

        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.shiftsCount).toBe(3);
        expect(dbMock.update).not.toHaveBeenCalled();
    });

    it('allows status:retired with force:true', async () => {
        setupDb({ workflowCount: 3 });
        const { handleUpdateAgent } = await import('../routes/agents.crud');
        const app = appWithUpdateContext();
        app.patch('/agents/:id', handleUpdateAgent);

        const res = await app.request('/agents/agent-1', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'retired', force: true }),
        });

        expect(res.status).toBe(200);
        expect(dbMock.update).toHaveBeenCalled();
    });

    it('does not run the dependency check for non-retiring updates (e.g. status:paused)', async () => {
        setupDb({ workflowCount: 3 });
        const { handleUpdateAgent } = await import('../routes/agents.crud');
        const app = appWithUpdateContext();
        app.patch('/agents/:id', handleUpdateAgent);

        const res = await app.request('/agents/agent-1', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'paused' }),
        });

        expect(res.status).toBe(200);
        expect(dbMock.update).toHaveBeenCalled();
    });
});
