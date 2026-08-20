import { describe, it, expect, vi, beforeEach } from 'vitest';
import { agents } from '@serverless-saas/agent-schema/agents';

const dbMock = vi.hoisted(() => ({
    select: vi.fn(),
    update: vi.fn(),
}));

vi.mock('../db', () => ({ db: dbMock }));

function appWithContext(permissions: Array<{ resource: string; action: string }>, role = 'member') {
    return async (path: string, init: RequestInit) => {
        const { agentsRoutes } = await import('../routes/agents');
        const { Hono } = await import('hono');
        const app = new Hono<any>();
        app.use('*', async (c, next) => {
            c.set('requestContext', { tenant: { id: 'tenant-1' }, permissions, role });
            c.set('userId', 'user-1');
            c.set('traceId', 'trace-1');
            await next();
        });
        app.route('/', agentsRoutes);
        return app.request(path, init);
    };
}

describe('GET /agents/:id — avatarParams', () => {
    beforeEach(() => vi.clearAllMocks());

    it('selects avatarParams alongside avatarUrl', async () => {
        let selectedColumns: Record<string, unknown> = {};
        dbMock.select.mockImplementation((columns: Record<string, unknown>) => {
            if (columns && 'avatarParams' in columns) selectedColumns = columns;
            return {
                from: () => ({
                    leftJoin: () => ({ where: () => ({ limit: async () => [{ id: 'agent-1', createdBy: null, personaId: null }] }) }),
                }),
            };
        });

        const request = appWithContext([{ resource: 'agents', action: 'read' }]);
        await request('/agent-1', { method: 'GET' });

        expect(selectedColumns).toHaveProperty('avatarParams', agents.avatarParams);
    });
});

describe('PATCH /agents/:id — avatarParams', () => {
    beforeEach(() => vi.clearAllMocks());

    const EXISTING_AGENT = { id: 'agent-1', tenantId: 'tenant-1', status: 'active' };

    function setupDb() {
        dbMock.select.mockImplementation(() => ({
            from: () => ({ where: () => ({ limit: async () => [EXISTING_AGENT] }) }),
        }));
        let updatedWith: Record<string, unknown> = {};
        dbMock.update.mockImplementation(() => ({
            set: (values: Record<string, unknown>) => {
                updatedWith = values;
                return { where: () => ({ returning: async () => [{ ...EXISTING_AGENT, ...values }] }) };
            },
        }));
        return () => updatedWith;
    }

    const AVATAR_PARAMS = {
        head: 'round', eyes: 'visor', accessory: 'hood', mouth: 'smile',
        skinColor: '#ffd8a8', hairColor: '#3b233a', bgTheme: 'space',
    };

    it('persists avatarParams for a full-update caller', async () => {
        const getUpdatedWith = setupDb();
        const request = appWithContext([{ resource: 'agents', action: 'update' }]);

        const response = await request('/agent-1', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatarUrl: 'https://cdn.example/a.svg', avatarParams: AVATAR_PARAMS }),
        });

        expect(response.status).toBe(200);
        expect(getUpdatedWith().avatarParams).toEqual(AVATAR_PARAMS);
    });

    it('persists avatarParams for an owner without the agents:update permission', async () => {
        const getUpdatedWith = setupDb();
        const request = appWithContext([], 'owner');

        const response = await request('/agent-1', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatarUrl: 'https://cdn.example/a.svg', avatarParams: AVATAR_PARAMS }),
        });

        expect(response.status).toBe(200);
        expect(getUpdatedWith().avatarParams).toEqual(AVATAR_PARAMS);
    });
});
