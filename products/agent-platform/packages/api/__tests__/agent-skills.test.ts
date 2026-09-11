import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { agents } from '@serverless-saas/agent-schema/agents';
import { agentSkills } from '@serverless-saas/agent-schema/conversations';
import { skillInstalls, skillVersions } from '@serverless-saas/agent-schema/skills';

const dbMock = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn(), update: vi.fn() }));
vi.mock('../db', () => ({ db: dbMock }));

const INSTALL_ID = '11111111-1111-4111-8111-111111111111';

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

interface DbState {
    /** undefined = a valid active install; null = none for this tenant. */
    install?: Record<string, unknown> | null;
    /** undefined = a ready manifest named bid-writer; null = no row. */
    manifest?: Record<string, unknown> | null;
    manifestStatus?: string;
    /** Active rows the cap counts. */
    active?: Array<{ name: string; installId: string | null }>;
    /** The agent's existing row for this install, active or archived. */
    existing?: Array<{ id: string }>;
    /** GET list result. */
    list?: Array<Record<string, unknown>>;
    insertError?: unknown;
}

function mockDb(state: DbState = {}) {
    const inserted: Record<string, unknown>[] = [];
    const updated: Record<string, unknown>[] = [];
    dbMock.select.mockImplementation(() => ({
        from: (table: unknown) => {
            if (table === agents) return { where: () => ({ limit: async () => [{ id: 'agent-1' }] }) };
            if (table === skillInstalls) {
                const rows = state.install === undefined
                    ? [{ id: INSTALL_ID, skillId: 'skill-1', installedVersion: 1 }]
                    : state.install ? [state.install] : [];
                return { where: () => ({ limit: async () => rows }) };
            }
            if (table === skillVersions) {
                const rows = state.manifest === null ? [] : [{
                    manifest: state.manifest ?? { name: 'bid-writer', body: 'Open with the client name.' },
                    status: state.manifestStatus ?? 'ready',
                }];
                return { where: () => ({ limit: async () => rows }) };
            }
            if (table === agentSkills) {
                // Three query shapes on this table: the cap count (awaited on
                // where), the existing-row lookup (where → orderBy → limit) and
                // the GET list (where → orderBy, awaited).
                return {
                    where: () => Object.assign(Promise.resolve(state.active ?? []), {
                        orderBy: () => Object.assign(Promise.resolve(state.list ?? []), {
                            limit: async () => state.existing ?? [],
                        }),
                    }),
                };
            }
            throw new Error('unexpected select target');
        },
    }));
    dbMock.insert.mockImplementation((table: unknown) => ({
        values: (data: Record<string, unknown>) => ({
            returning: async () => {
                if (table !== agentSkills) return [{ id: 'audit-1' }];
                if (state.insertError) throw state.insertError;
                inserted.push(data);
                return [{ id: 'row-new', ...data }];
            },
            catch: () => {},
        }),
    }));
    dbMock.update.mockImplementation(() => ({
        set: (data: Record<string, unknown>) => ({
            where: () => ({
                returning: async () => {
                    updated.push(data);
                    return [{ id: 'row-1', ...data }];
                },
            }),
        }),
    }));
    return { inserted, updated };
}

async function request(method: 'GET' | 'POST', body?: unknown, permission = 'create') {
    const { agentSkillsRoutes } = await import('../routes/agent-skills');
    const app = appWithContext(permission);
    app.route('/agents', agentSkillsRoutes);
    return app.request('/agents/agent-1/skills', {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}

const uniqueViolation = (constraint: string) => ({ cause: { code: '23505', constraint } });

describe('POST /agents/:agentId/skills — installed skills', () => {
    beforeEach(() => vi.clearAllMocks());

    it("stores the manifest's name, ignoring the name the client sent", async () => {
        const { inserted } = mockDb();
        const res = await request('POST', { name: 'Bid Writer (display name)', installId: INSTALL_ID });
        expect(res.status).toBe(201);
        expect(inserted[0]).toMatchObject({ name: 'bid-writer', installId: INSTALL_ID, systemPrompt: 'Open with the client name.' });
    });

    it('ignores a client-supplied systemPrompt for an installed skill', async () => {
        const { inserted } = mockDb();
        await request('POST', { name: 'x', installId: INSTALL_ID, systemPrompt: 'injected' });
        expect(inserted[0].systemPrompt).toBe('Open with the client name.');
    });

    it("reactivates the agent's existing row for the install instead of inserting a second", async () => {
        const { inserted, updated } = mockDb({ existing: [{ id: 'row-1' }] });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(200);
        expect(inserted).toHaveLength(0);
        expect(updated[0]).toMatchObject({ status: 'active', name: 'bid-writer', systemPrompt: 'Open with the client name.' });
    });

    it("returns 404 for an install that isn't this tenant's active install", async () => {
        mockDb({ install: null });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(404);
    });

    it('returns 409 NOT_READY when the pinned version has no readable body', async () => {
        mockDb({ manifestStatus: 'pending' });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('NOT_READY');
    });

    it('rejects a non-uuid installId', async () => {
        mockDb();
        const res = await request('POST', { name: 'x', installId: 'not-a-uuid' });
        expect(res.status).toBe(400);
    });

    it('returns 409 CONFLICT when a concurrent attach of the same install wins the race', async () => {
        mockDb({ insertError: uniqueViolation('agent_skills_agent_install_active_unique') });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('CONFLICT');
    });

    it('returns 409 NAME_CONFLICT when a different skill already uses the name', async () => {
        mockDb({ insertError: uniqueViolation('agent_skills_agent_id_tenant_id_name_version_unique') });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('NAME_CONFLICT');
    });

    it('has no character budget: a long skill attaches', async () => {
        const { inserted } = mockDb({ manifest: { name: 'long-skill', body: 'x'.repeat(30_000) } });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(201);
        expect(inserted).toHaveLength(1);
    });
});

describe('POST /agents/:agentId/skills — the 8-skill cap', () => {
    beforeEach(() => vi.clearAllMocks());

    const others = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `skill-${i}`, installId: `install-${i}` }));

    it('refuses a ninth skill', async () => {
        mockDb({ active: others(8) });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('SKILL_BUDGET_EXCEEDED');
    });

    it("does not count the agent's 'default' row, which is its base prompt", async () => {
        mockDb({ active: [{ name: 'default', installId: null }, ...others(7)] });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(201);
    });

    it('does not count the install being re-attached against itself', async () => {
        mockDb({ active: [...others(7), { name: 'bid-writer', installId: INSTALL_ID }], existing: [{ id: 'row-1' }] });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(200);
    });
});

describe('POST /agents/:agentId/skills — hand-authored skills', () => {
    beforeEach(() => vi.clearAllMocks());

    it("creates a hand-authored skill with the client's name and prompt", async () => {
        const { inserted } = mockDb();
        const res = await request('POST', { name: 'Custom Skill', systemPrompt: 'You do X.' });
        expect(res.status).toBe(201);
        expect(inserted[0]).toMatchObject({ name: 'Custom Skill', systemPrompt: 'You do X.', installId: null });
    });

    it('still requires systemPrompt without an installId', async () => {
        mockDb();
        const res = await request('POST', { name: 'Custom Skill' });
        expect(res.status).toBe(400);
    });

    it('rejects without agents:create permission', async () => {
        mockDb();
        const res = await request('POST', { name: 'Custom Skill', systemPrompt: 'You do X.' }, 'read');
        expect(res.status).toBe(403);
    });
});

describe('GET /agents/:agentId/skills', () => {
    beforeEach(() => vi.clearAllMocks());

    it("lists attached skills without the agent's 'default' row", async () => {
        mockDb({ list: [{ id: 'a', name: 'default' }, { id: 'b', name: 'bid-writer' }] });
        const res = await request('GET', undefined, 'read');
        expect(res.status).toBe(200);
        expect((await res.json()).data).toEqual([{ id: 'b', name: 'bid-writer' }]);
    });
});
