import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
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
    /** The agent's existing row for this install, active or archived
     * (the install-scoped lookup). */
    existing?: Array<{ id: string }>;
    /** An archived row sharing this attach's name+version, unrelated to the
     * install-scoped lookup (the reinstall-under-a-new-install-id path). */
    archived?: Array<{ id: string }>;
    /** GET list result. */
    list?: Array<Record<string, unknown>>;
    insertError?: unknown;
    /** 1-based update-call indices that should return zero rows, to model a
     * row vanishing between lookup and update. */
    emptyUpdateOnCall?: number[];
}

function mockDb(state: DbState = {}) {
    const inserted: Record<string, unknown>[] = [];
    const updated: Array<{ data: Record<string, unknown>; where: unknown }> = [];
    // Every `where()` call against agentSkills, in call order. Tests index
    // into this knowing the route's fixed call sequence for the scenario
    // they set up (see comments at each call site below).
    const agentSkillsWhereCalls: unknown[] = [];
    let updateCallCount = 0;

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
                // Four query shapes share this table:
                //  - the cap count: awaited on where() directly -> state.active
                //  - the GET list: where().orderBy() awaited directly -> state.list
                //  - the install-scoped existing-row lookup:
                //    where().orderBy().limit() -> state.existing
                //  - the archived name+version lookup: where().limit() -> state.archived
                return {
                    where: (whereArg: unknown) => {
                        agentSkillsWhereCalls.push(whereArg);
                        return Object.assign(Promise.resolve(state.active ?? []), {
                            orderBy: () => Object.assign(Promise.resolve(state.list ?? []), {
                                limit: async () => state.existing ?? [],
                            }),
                            limit: async () => state.archived ?? [],
                        });
                    },
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
            where: (whereArg: unknown) => ({
                returning: async () => {
                    updateCallCount += 1;
                    updated.push({ data, where: whereArg });
                    if ((state.emptyUpdateOnCall ?? []).includes(updateCallCount)) return [];
                    return [{ id: 'row-1', ...data }];
                },
            }),
        }),
    }));
    return { inserted, updated, agentSkillsWhereCalls };
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

// postgres.js (this repo's driver) reports the violated index as
// `constraint_name`, not `constraint` — the node-postgres key. See
// apps/api/src/middleware/userUpsert.ts:102-104 for the same distinction.
const uniqueViolation = (constraint_name: string) => ({ cause: { code: '23505', constraint_name } });

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

    it('slices a manifest name over 100 characters, matching the client-name limit', async () => {
        const longName = 'n'.repeat(150);
        const { inserted } = mockDb({ manifest: { name: longName, body: 'body' } });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(201);
        expect(inserted[0].name).toBe(longName.slice(0, 100));
    });

    it("reactivates the agent's existing row for the install instead of inserting a second, without renaming it", async () => {
        const { inserted, updated } = mockDb({ existing: [{ id: 'row-1' }] });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(200);
        expect(inserted).toHaveLength(0);
        // Call order for this scenario: [0] cap count, [1] the
        // install-scoped existing-row lookup. The archived-name/version
        // lookup and the insert are never reached.
        expect(updated).toHaveLength(1);
        expect(updated[0].data).toMatchObject({ status: 'active', systemPrompt: 'Open with the client name.' });
        expect(updated[0].data).not.toHaveProperty('name');
    });

    it("scopes the existing-row lookup and its reactivation UPDATE to this tenant", async () => {
        const { updated, agentSkillsWhereCalls } = mockDb({ existing: [{ id: 'row-1' }] });
        await request('POST', { name: 'x', installId: INSTALL_ID });

        // [0] = cap count's where, [1] = the install-scoped existing-row lookup's where.
        const existingLookupWhere = agentSkillsWhereCalls[1];
        expect(existingLookupWhere).toEqual(and(
            eq(agentSkills.agentId, 'agent-1'),
            eq(agentSkills.tenantId, 'tenant-1'),
            eq(agentSkills.installId, INSTALL_ID),
        ));

        const updateWhere = updated[0].where;
        expect(updateWhere).toEqual(and(
            eq(agentSkills.id, 'row-1'),
            eq(agentSkills.tenantId, 'tenant-1'),
        ));
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

    it('falls through to the insert path when the reactivation UPDATE returns no rows (the row vanished between lookup and update)', async () => {
        const { inserted, updated } = mockDb({ existing: [{ id: 'row-1' }], emptyUpdateOnCall: [1] });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(201);
        expect(updated).toHaveLength(1); // the failed reactivate attempt
        expect(inserted).toHaveLength(1);
    });

    it('reactivates an archived row with the same name+version instead of inserting, when it belongs to a different (reinstalled) install', async () => {
        const { inserted, updated, agentSkillsWhereCalls } = mockDb({ archived: [{ id: 'archived-row-1' }] });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID });
        expect(res.status).toBe(200);
        expect(inserted).toHaveLength(0);
        expect(updated).toHaveLength(1);
        expect(updated[0].data).toMatchObject({ installId: INSTALL_ID, systemPrompt: 'Open with the client name.', status: 'active' });

        // Call order here: [0] cap count, [1] install-scoped existing-row
        // lookup (returns none), [2] the archived name+version lookup.
        const archivedLookupWhere = agentSkillsWhereCalls[2];
        expect(archivedLookupWhere).toEqual(and(
            eq(agentSkills.agentId, 'agent-1'),
            eq(agentSkills.tenantId, 'tenant-1'),
            eq(agentSkills.name, 'bid-writer'),
            eq(agentSkills.version, 1),
            eq(agentSkills.status, 'archived'),
        ));
        expect(updated[0].where).toEqual(and(
            eq(agentSkills.id, 'archived-row-1'),
            eq(agentSkills.tenantId, 'tenant-1'),
        ));
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

    it('compares the cap against the resolved (lowercase) install id, not the raw client value, for an uppercase installId', async () => {
        mockDb({ active: [...others(7), { name: 'bid-writer', installId: INSTALL_ID }], existing: [{ id: 'row-1' }] });
        const res = await request('POST', { name: 'x', installId: INSTALL_ID.toUpperCase() });
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

    it('reactivates an archived hand-authored row with the same name+version instead of inserting', async () => {
        const { inserted, updated, agentSkillsWhereCalls } = mockDb({ archived: [{ id: 'archived-row-2' }] });
        const res = await request('POST', { name: 'Custom Skill', systemPrompt: 'You do X.' });
        expect(res.status).toBe(200);
        expect(inserted).toHaveLength(0);
        expect(updated).toHaveLength(1);
        expect(updated[0].data).toMatchObject({ installId: null, systemPrompt: 'You do X.', status: 'active' });

        // Call order for a hand-authored attach: [0] cap count, [1] the
        // archived name+version lookup — the install-scoped lookup is
        // skipped entirely (no installId).
        const archivedLookupWhere = agentSkillsWhereCalls[1];
        expect(archivedLookupWhere).toEqual(and(
            eq(agentSkills.agentId, 'agent-1'),
            eq(agentSkills.tenantId, 'tenant-1'),
            eq(agentSkills.name, 'Custom Skill'),
            eq(agentSkills.version, 1),
            eq(agentSkills.status, 'archived'),
        ));
        expect(updated[0].where).toEqual(and(
            eq(agentSkills.id, 'archived-row-2'),
            eq(agentSkills.tenantId, 'tenant-1'),
        ));
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
