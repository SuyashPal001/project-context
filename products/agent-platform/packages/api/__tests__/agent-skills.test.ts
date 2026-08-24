import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { agents } from '@serverless-saas/agent-schema/agents';
import { agentSkills } from '@serverless-saas/agent-schema/conversations';
import { skillInstalls, skillVersions } from '@serverless-saas/agent-schema/skills';

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

// installRows is what the tenant-scoped skill_installs lookup resolves to —
// [] models "no such install row for this tenant" (never installed, wrong
// tenant, or uninstalled), which the route treats identically.
function mockResolveAgent(installRows: Record<string, unknown>[] = []) {
    dbMock.select.mockImplementation(() => ({
        from: (table: unknown) => {
            if (table === agents) return { where: () => ({ limit: async () => [{ id: 'agent-1' }] }) };
            if (table === skillInstalls) return { where: () => ({ limit: async () => installRows }) };
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
        const installId = '11111111-1111-4111-8111-111111111111';
        dbMock.select.mockImplementation(() => ({
            from: (table: unknown) => {
                if (table === agents) return { where: () => ({ limit: async () => [{ id: 'agent-1' }] }) };
                if (table === skillInstalls) return { where: () => ({ limit: async () => [{ id: installId, skillId: 'skill-1', installedVersion: 1 }] }) };
                if (table === skillVersions) return { where: () => ({ limit: async () => [{ status: 'ready', manifest: { body: '# Body' } }] }) };
                throw new Error('unexpected select target');
            },
        }));
        dbMock.insert.mockImplementation((table: unknown) => ({
            values: (data: Record<string, unknown>) => ({
                returning: async () => (table === agentSkills ? [{ id: 'skill-2', ...data }] : [{ id: 'audit-2' }]),
                catch: () => {},
            }),
        }));

        const { agentSkillsRoutes } = await import('../routes/agent-skills');
        const app = appWithContext();
        app.route('/agents', agentSkillsRoutes);

        const res = await app.request('/agents/agent-1/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'PDF Tools', installId }),
        });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.data.installId).toBe(installId);
    });

    it("returns 404 for an installId that isn't this tenant's active install row", async () => {
        mockResolveAgent([]);
        dbMock.insert.mockImplementation(() => ({
            values: () => ({ returning: async () => [{ id: 'skill-3' }], catch: () => {} }),
        }));

        const { agentSkillsRoutes } = await import('../routes/agent-skills');
        const app = appWithContext();
        app.route('/agents', agentSkillsRoutes);

        const res = await app.request('/agents/agent-1/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'PDF Tools',
                systemPrompt: 'Use the PDF tool.',
                installId: '99999999-9999-4999-8999-999999999999',
            }),
        });

        expect(res.status).toBe(404);
        expect((await res.json()).code).toBe('NOT_FOUND');
        expect(dbMock.insert).not.toHaveBeenCalled();
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

describe('POST /agents/:agentId/skills — server-derived system prompt', () => {
    beforeEach(() => vi.clearAllMocks());

    const INSTALL_ID = '11111111-1111-4111-8111-111111111111';
    const SKILL_BODY = '# PDF Tools\n\nUse pdftotext before answering.';

    function mockAttach(versionRows: Record<string, unknown>[]) {
        dbMock.select.mockImplementation(() => ({
            from: (table: unknown) => {
                if (table === agents) return { where: () => ({ limit: async () => [{ id: 'agent-1' }] }) };
                if (table === skillInstalls) return { where: () => ({ limit: async () => [{ id: INSTALL_ID, skillId: 'skill-1', installedVersion: 2 }] }) };
                if (table === skillVersions) return { where: () => ({ limit: async () => versionRows }) };
                throw new Error('unexpected select target');
            },
        }));
        dbMock.insert.mockImplementation((table: unknown) => ({
            values: (data: Record<string, unknown>) => ({
                returning: async () => (table === agentSkills ? [{ id: 'skill-row-1', ...data }] : [{ id: 'audit-1' }]),
                catch: () => {},
            }),
        }));
    }

    it("stores the installed version's manifest body, ignoring any client-supplied systemPrompt", async () => {
        mockAttach([{ status: 'ready', manifest: { body: SKILL_BODY } }]);

        const { agentSkillsRoutes } = await import('../routes/agent-skills');
        const app = appWithContext();
        app.route('/agents', agentSkillsRoutes);

        const res = await app.request('/agents/agent-1/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'PDF Tools', systemPrompt: 'a short description', installId: INSTALL_ID }),
        });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.data.systemPrompt).toBe(SKILL_BODY);
    });

    it('returns 409 NOT_READY when the pinned version has no readable body', async () => {
        mockAttach([{ status: 'pending', manifest: null }]);

        const { agentSkillsRoutes } = await import('../routes/agent-skills');
        const app = appWithContext();
        app.route('/agents', agentSkillsRoutes);

        const res = await app.request('/agents/agent-1/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'PDF Tools', installId: INSTALL_ID }),
        });

        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('NOT_READY');
    });

    it('still requires systemPrompt for a hand-authored skill with no installId', async () => {
        dbMock.select.mockImplementation(() => ({
            from: () => ({ where: () => ({ limit: async () => [{ id: 'agent-1' }] }) }),
        }));

        const { agentSkillsRoutes } = await import('../routes/agent-skills');
        const app = appWithContext();
        app.route('/agents', agentSkillsRoutes);

        const res = await app.request('/agents/agent-1/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Custom Skill' }),
        });

        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('VALIDATION_ERROR');
    });
});
