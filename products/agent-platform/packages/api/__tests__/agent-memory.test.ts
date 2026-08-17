import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { agents } from '@serverless-saas/agent-schema/agents';
import { agentMemories } from '@serverless-saas/agent-schema/agents';

const dbMock = vi.hoisted(() => ({
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
}));

vi.mock('../db', () => ({ db: dbMock }));

const EXISTING_AGENT = { id: 'agent-1' };

function appWithContext() {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
        c.set('requestContext', {
            tenant: { id: 'tenant-1' },
            permissions: [{ resource: 'agents', action: 'read' }, { resource: 'agents', action: 'update' }],
        });
        c.set('userId', 'user-1');
        await next();
    });
    return app;
}

describe('GET /agents/:agentId/memory', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns empty content when no memory row exists yet', async () => {
        dbMock.select.mockImplementation(() => ({
            from: (table: unknown) => {
                if (table === agents) return { where: () => ({ limit: async () => [EXISTING_AGENT] }) };
                if (table === agentMemories) return { where: () => ({ limit: async () => [] }) };
                throw new Error('unexpected select target');
            },
        }));

        const { agentMemoryRoutes } = await import('../routes/agent-memory');
        const app = appWithContext();
        app.route('/agents', agentMemoryRoutes);

        const res = await app.request('/agents/agent-1/memory');

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.content).toBe('');
    });
});

describe('PUT /agents/:agentId/memory', () => {
    beforeEach(() => vi.clearAllMocks());

    it('upserts the memory content and returns it', async () => {
        dbMock.select.mockImplementation(() => ({
            from: (table: unknown) => {
                if (table === agents) return { where: () => ({ limit: async () => [EXISTING_AGENT] }) };
                throw new Error('unexpected select target');
            },
        }));
        dbMock.insert.mockImplementation(() => ({
            values: () => ({
                onConflictDoUpdate: () => ({
                    returning: async () => [{ content: 'Learned the tenant prefers dark mode.', updatedAt: new Date('2026-01-01') }],
                }),
            }),
        }));

        const { agentMemoryRoutes } = await import('../routes/agent-memory');
        const app = appWithContext();
        app.route('/agents', agentMemoryRoutes);

        const res = await app.request('/agents/agent-1/memory', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'Learned the tenant prefers dark mode.' }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.content).toBe('Learned the tenant prefers dark mode.');
    });
});
