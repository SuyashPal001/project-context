import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { agents } from '@serverless-saas/agent-schema/agents';
import { agentSkills } from '@serverless-saas/agent-schema/conversations';

const dbMock = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn() }));
vi.mock('../db', () => ({ db: dbMock }));

function appWithContext(permissionAction = 'create') {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
        c.set('requestContext', { tenant: { id: 'tenant-1' }, permissions: [{ resource: 'agents', action: permissionAction }] });
        c.set('userId', 'user-1');
        c.set('traceId', 'trace-1');
        await next();
    });
    return app;
}

function mockResolveAgent() {
    dbMock.select.mockImplementation(() => ({
        from: (table: unknown) => {
            if (table === agents) return { where: () => ({ limit: async () => [{ id: 'agent-1' }] }) };
            throw new Error('unexpected select target');
        },
    }));
}

describe('POST /agents/:agentId/skills', () => {
    beforeEach(() => vi.clearAllMocks());

    it('creates a hand-authored skill with installId null when omitted (existing behavior unchanged)', async () => {
        mockResolveAgent();
        dbMock.insert.mockImplementation((table: unknown) => ({
            values: (data: Record<string, unknown>) => ({
                returning: async () => (table === agentSkills ? [{ id: 'skill-1', ...data }] : [{ id: 'audit-1' }]),
                catch: () => {},
            }),
        }));

        const { agentSkillsRoutes } = await import('../routes/agent-skills');
        const app = appWithContext();
        app.route('/agents', agentSkillsRoutes);

        const res = await app.request('/agents/agent-1/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Custom Skill', systemPrompt: 'You do X.' }),
        });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.data.name).toBe('Custom Skill');
        expect(body.data.installId).toBeNull();
    });

    it('accepts installId and stores it on the created row when attaching an installed skill', async () => {
        mockResolveAgent();
        dbMock.insert.mockImplementation((table: unknown) => ({
            values: (data: Record<string, unknown>) => ({
                returning: async () => (table === agentSkills ? [{ id: 'skill-2', ...data }] : [{ id: 'audit-2' }]),
                catch: () => {},
            }),
        }));

        const { agentSkillsRoutes } = await import('../routes/agent-skills');
        const app = appWithContext();
        app.route('/agents', agentSkillsRoutes);

        const installId = '11111111-1111-4111-8111-111111111111';
        const res = await app.request('/agents/agent-1/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'PDF Tools', systemPrompt: 'Use the PDF tool.', installId }),
        });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.data.installId).toBe(installId);
    });

    it('rejects a non-uuid installId', async () => {
        mockResolveAgent();

        const { agentSkillsRoutes } = await import('../routes/agent-skills');
        const app = appWithContext();
        app.route('/agents', agentSkillsRoutes);

        const res = await app.request('/agents/agent-1/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'PDF Tools', systemPrompt: 'Use the PDF tool.', installId: 'not-a-uuid' }),
        });

        expect(res.status).toBe(400);
    });

    it('rejects without agents:create permission', async () => {
        const { agentSkillsRoutes } = await import('../routes/agent-skills');
        const app = appWithContext('read');
        app.route('/agents', agentSkillsRoutes);

        const res = await app.request('/agents/agent-1/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Custom Skill', systemPrompt: 'You do X.' }),
        });

        expect(res.status).toBe(403);
    });
});
