import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { agents } from '@serverless-saas/agent-schema/agents';
import { agentSkills } from '@serverless-saas/agent-schema/conversations';
import { skillInstalls, skillVersions } from '@serverless-saas/agent-schema/skills';

const dbMock = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn(), update: vi.fn() }));
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
            // Prompt-budget cap check — no active skills attached yet in these tests.
            if (table === agentSkills) return { where: async () => [] };
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
                if (table === agentSkills) return { where: async () => [] };
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
                if (table === agentSkills) return { where: async () => [] };
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

describe('POST /agents/:agentId/skills — prompt budget caps', () => {
    beforeEach(() => vi.clearAllMocks());

    // Models the cap-check's select: table === agents resolves the agent,
    // table === agentSkills (queried without installId/skillInstalls
    // involvement here) resolves to the tenant's currently-active rows. The
    // cap-check query has no `.limit()` in the handler, so `.where()` itself
    // resolves directly to the row array.
    function mockActiveSkills(rows: Record<string, unknown>[]) {
        dbMock.select.mockImplementation(() => ({
            from: (table: unknown) => {
                if (table === agents) return { where: () => ({ limit: async () => [{ id: 'agent-1' }] }) };
                if (table === agentSkills) return { where: async () => rows };
                throw new Error('unexpected select target');
            },
        }));
        dbMock.insert.mockImplementation((table: unknown) => ({
            values: (data: Record<string, unknown>) => ({
                returning: async () => (table === agentSkills ? [{ id: 'new-skill', ...data }] : [{ id: 'audit-1' }]),
                catch: () => {},
            }),
        }));
    }

    async function postAttach(body: Record<string, unknown>) {
        const { agentSkillsRoutes } = await import('../routes/agent-skills');
        const app = appWithContext();
        app.route('/agents', agentSkillsRoutes);

        return app.request('/agents/agent-1/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    it('refuses an attach that would exceed the attached-skill count cap', async () => {
        // 8 skills already attached — the 9th must be refused, not truncated later.
        mockActiveSkills(Array.from({ length: 8 }, (_, i) => ({ name: `skill-${i}`, systemPrompt: 'body' })));

        const res = await postAttach({ name: 'ninth', systemPrompt: 'body' });

        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('SKILL_BUDGET_EXCEEDED');
    });

    it('refuses an attach that would exceed the composed character budget', async () => {
        mockActiveSkills([{ name: 'huge', systemPrompt: 'x'.repeat(23_900) }]);

        const res = await postAttach({ name: 'small', systemPrompt: 'y'.repeat(500) });

        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('SKILL_BUDGET_EXCEEDED');
    });

    it('allows an attach that fits inside both caps', async () => {
        mockActiveSkills([{ name: 'one', systemPrompt: 'short' }]);

        const res = await postAttach({ name: 'two', systemPrompt: 'also short' });

        expect(res.status).toBe(201);
    });

    it('refuses a set that fits the raw body-length sum but exceeds budget once the orchestrator\'s per-skill header cost is counted', async () => {
        // The orchestrator composes each skill as "## Skill: <name>\n\n<body>",
        // costing body.trim().length + name.length + 15 per skill (usage.ts:101).
        // 8 active skills at 2975 chars each (raw sum 23,800) plus a 100-char
        // attach sums to 23,900 raw — under the 24,000 cap by the old,
        // header-blind math. Once every one of the 9 skills' 2-char name +
        // 15-char header overhead (17 each, 153 total) is added, the true
        // composed cost is 24,053 — over budget, and this must be refused.
        mockActiveSkills(Array.from({ length: 8 }, (_, i) => ({ name: `s${i}`, systemPrompt: 'x'.repeat(2975) })));

        const res = await postAttach({ name: 's8', systemPrompt: 'y'.repeat(100) });

        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('SKILL_BUDGET_EXCEEDED');
    });
});

describe('POST /agents/:agentId/skills — reconcile stale prompt on 23505 re-attach conflict', () => {
    beforeEach(() => vi.clearAllMocks());

    const INSTALL_ID = '11111111-1111-4111-8111-111111111111';
    const NEW_BODY = '# PDF Tools v3\n\nUse pdftotext, now with OCR fallback.';

    function conflictingInsert() {
        dbMock.insert.mockImplementation((table: unknown) => ({
            values: () => ({
                returning: async () => {
                    if (table === agentSkills) {
                        const err: any = new Error('duplicate key value violates unique constraint');
                        err.code = '23505';
                        throw err;
                    }
                    return [{ id: 'audit-1' }];
                },
                catch: () => {},
            }),
        }));
    }

    it('updates the existing row and returns 200 when the conflicting attach carries an installId', async () => {
        dbMock.select.mockImplementation(() => ({
            from: (table: unknown) => {
                if (table === agents) return { where: () => ({ limit: async () => [{ id: 'agent-1' }] }) };
                if (table === skillInstalls) return { where: () => ({ limit: async () => [{ id: INSTALL_ID, skillId: 'skill-1', installedVersion: 3 }] }) };
                if (table === skillVersions) return { where: () => ({ limit: async () => [{ status: 'ready', manifest: { body: NEW_BODY } }] }) };
                if (table === agentSkills) return { where: async () => [] };
                throw new Error('unexpected select target');
            },
        }));
        conflictingInsert();

        const updatedRow = {
            id: 'existing-skill-1',
            agentId: 'agent-1',
            tenantId: 'tenant-1',
            name: 'PDF Tools',
            version: 1,
            systemPrompt: NEW_BODY,
            tools: [],
            config: null,
            installId: INSTALL_ID,
        };
        const whereSpy = vi.fn(() => ({ returning: async () => [updatedRow] }));
        const setSpy = vi.fn(() => ({ where: whereSpy }));
        dbMock.update.mockImplementation((table: unknown) => {
            if (table === agentSkills) return { set: setSpy };
            throw new Error('unexpected update target');
        });

        const { agentSkillsRoutes } = await import('../routes/agent-skills');
        const app = appWithContext();
        app.route('/agents', agentSkillsRoutes);

        const res = await app.request('/agents/agent-1/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'PDF Tools', installId: INSTALL_ID }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.systemPrompt).toBe(NEW_BODY);

        // The UPDATE writes the freshly-resolved prompt/tools/config.
        expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({
            systemPrompt: NEW_BODY,
            tools: [],
            config: null,
        }));

        // The UPDATE is scoped to exactly the tuple the unique constraint covers:
        // [agentId, tenantId, name, version] — never a different row.
        const expectedWhere = and(
            eq(agentSkills.agentId, 'agent-1'),
            eq(agentSkills.tenantId, 'tenant-1'),
            eq(agentSkills.name, 'PDF Tools'),
            eq(agentSkills.version, 1),
        );
        expect(whereSpy).toHaveBeenCalledWith(expectedWhere);
    });

    it("excludes the re-attached skill's own current row from both caps so a re-attach at the count cap still reconciles instead of being refused", async () => {
        // 8 active rows total, one of which is the very row this attach is
        // re-attaching ('PDF Tools'). Before excluding the row being
        // replaced, active.length (8) >= MAX_ATTACHED_SKILLS (8) would wrongly
        // refuse this — a re-attach isn't a new attachment, and the previous
        // implementation never reached the 23505 -> UPDATE reconcile path at
        // all for a same-size or larger re-attach at the cap.
        const activeRows = [
            ...Array.from({ length: 7 }, (_, i) => ({ name: `other-${i}`, systemPrompt: 'short body' })),
            { name: 'PDF Tools', systemPrompt: 'the stale body being replaced' },
        ];
        dbMock.select.mockImplementation(() => ({
            from: (table: unknown) => {
                if (table === agents) return { where: () => ({ limit: async () => [{ id: 'agent-1' }] }) };
                if (table === skillInstalls) return { where: () => ({ limit: async () => [{ id: INSTALL_ID, skillId: 'skill-1', installedVersion: 3 }] }) };
                if (table === skillVersions) return { where: () => ({ limit: async () => [{ status: 'ready', manifest: { body: NEW_BODY } }] }) };
                if (table === agentSkills) return { where: async () => activeRows };
                throw new Error('unexpected select target');
            },
        }));
        conflictingInsert();

        const updatedRow = {
            id: 'existing-skill-1',
            agentId: 'agent-1',
            tenantId: 'tenant-1',
            name: 'PDF Tools',
            version: 1,
            systemPrompt: NEW_BODY,
            tools: [],
            config: null,
            installId: INSTALL_ID,
        };
        dbMock.update.mockImplementation((table: unknown) => {
            if (table === agentSkills) return { set: () => ({ where: () => ({ returning: async () => [updatedRow] }) }) };
            throw new Error('unexpected update target');
        });

        const { agentSkillsRoutes } = await import('../routes/agent-skills');
        const app = appWithContext();
        app.route('/agents', agentSkillsRoutes);

        const res = await app.request('/agents/agent-1/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'PDF Tools', installId: INSTALL_ID }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.systemPrompt).toBe(NEW_BODY);
    });

    it('falls back to 409 CONFLICT unchanged when the conflicting attach has no installId (hand-authored skill)', async () => {
        dbMock.select.mockImplementation(() => ({
            from: (table: unknown) => {
                if (table === agents) return { where: () => ({ limit: async () => [{ id: 'agent-1' }] }) };
                if (table === agentSkills) return { where: async () => [] };
                throw new Error('unexpected select target');
            },
        }));
        conflictingInsert();
        dbMock.update.mockImplementation(() => {
            throw new Error('update should not be called for a hand-authored skill conflict');
        });

        const { agentSkillsRoutes } = await import('../routes/agent-skills');
        const app = appWithContext();
        app.route('/agents', agentSkillsRoutes);

        const res = await app.request('/agents/agent-1/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Custom Skill', systemPrompt: 'You do X.' }),
        });

        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('CONFLICT');
        expect(dbMock.update).not.toHaveBeenCalled();
    });

    it('falls back to 409 CONFLICT if the reconciling UPDATE matches zero rows (race condition)', async () => {
        dbMock.select.mockImplementation(() => ({
            from: (table: unknown) => {
                if (table === agents) return { where: () => ({ limit: async () => [{ id: 'agent-1' }] }) };
                if (table === skillInstalls) return { where: () => ({ limit: async () => [{ id: INSTALL_ID, skillId: 'skill-1', installedVersion: 3 }] }) };
                if (table === skillVersions) return { where: () => ({ limit: async () => [{ status: 'ready', manifest: { body: NEW_BODY } }] }) };
                if (table === agentSkills) return { where: async () => [] };
                throw new Error('unexpected select target');
            },
        }));
        conflictingInsert();
        dbMock.update.mockImplementation((table: unknown) => {
            if (table === agentSkills) return { set: () => ({ where: () => ({ returning: async () => [] }) }) };
            throw new Error('unexpected update target');
        });

        const { agentSkillsRoutes } = await import('../routes/agent-skills');
        const app = appWithContext();
        app.route('/agents', agentSkillsRoutes);

        const res = await app.request('/agents/agent-1/skills', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'PDF Tools', installId: INSTALL_ID }),
        });

        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('CONFLICT');
    });
});
