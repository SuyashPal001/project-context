import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { agents } from '@serverless-saas/agent-schema/agents';
import { teams, teamMembers } from '@serverless-saas/agent-schema/teams';

const dbMock = vi.hoisted(() => ({
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
}));

vi.mock('../db', () => ({ db: dbMock }));

function appWithContext(permissionAction = 'create') {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
        c.set('requestContext', {
            tenant: { id: 'tenant-1' },
            permissions: [{ resource: 'agents', action: permissionAction }, { resource: 'agents', action: 'read' }],
        });
        c.set('userId', 'user-1');
        c.set('traceId', 'trace-1');
        await next();
    });
    return app;
}

describe('POST /teams', () => {
    beforeEach(() => vi.clearAllMocks());

    it('creates a team with a name', async () => {
        dbMock.insert.mockImplementation((table: unknown) => ({
            values: (data: Record<string, unknown>) => ({
                returning: async () => {
                    if (table === teams) return [{ id: 'team-1', ...data }];
                    return [];
                },
            }),
        }));

        const { teamsRoutes } = await import('../routes/teams');
        const app = appWithContext();
        app.route('/teams', teamsRoutes);

        const res = await app.request('/teams', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Content Squad' }),
        });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.data.name).toBe('Content Squad');
    });
});

describe('POST /teams/:teamId/members/:agentId', () => {
    beforeEach(() => vi.clearAllMocks());

    it('adds an agent from this tenant to the team', async () => {
        dbMock.select.mockImplementation(() => ({
            from: (table: unknown) => {
                if (table === teams) return { where: () => ({ limit: async () => [{ id: 'team-1', tenantId: 'tenant-1' }] }) };
                if (table === agents) return { where: () => ({ limit: async () => [{ id: 'agent-1', tenantId: 'tenant-1' }] }) };
                throw new Error('unexpected select target');
            },
        }));
        dbMock.insert.mockImplementation(() => ({
            values: () => ({ onConflictDoNothing: () => Promise.resolve([]) }),
        }));

        const { teamsRoutes } = await import('../routes/teams');
        const app = appWithContext('update');
        app.route('/teams', teamsRoutes);

        const res = await app.request('/teams/team-1/members/agent-1', { method: 'POST' });

        expect(res.status).toBe(200);
    });
});

describe('Fire dependency check — real teamsCount', () => {
    beforeEach(() => vi.clearAllMocks());

    it('DELETE /agents/:id counts team_members rows for the agent', async () => {
        const { agentWorkflows } = await import('@serverless-saas/agent-schema/agents');
        dbMock.select.mockImplementation(() => ({
            from: (table: unknown) => {
                if (table === agents) return { where: () => ({ limit: async () => [{ id: 'agent-1', tenantId: 'tenant-1', apiKeyId: 'key-1', status: 'active' }] }) };
                if (table === agentWorkflows) return { where: async () => [{ value: 0 }] };
                if (table === teamMembers) return { where: async () => [{ value: 2 }] };
                throw new Error('unexpected select target');
            },
        }));

        const { handleDeleteAgent } = await import('../routes/agents.crud');
        const app = new Hono<any>();
        app.use('*', async (c, next) => {
            c.set('requestContext', { tenant: { id: 'tenant-1' }, permissions: [{ resource: 'agents', action: 'delete' }] });
            c.set('userId', 'user-1');
            c.set('traceId', 'trace-1');
            await next();
        });
        app.delete('/agents/:id', handleDeleteAgent);

        const res = await app.request('/agents/agent-1', { method: 'DELETE' });

        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.teamsCount).toBe(2);
    });
});
