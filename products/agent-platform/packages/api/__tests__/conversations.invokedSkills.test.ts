import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Same harness as conversations.folderScope.test.ts: assert the payload
// handed to db.update().set(), which is the real merge behaviour.
vi.mock('@serverless-saas/database/client', () => ({
    db: { select: vi.fn(), update: vi.fn() },
}));
vi.mock('@serverless-saas/agent-schema/conversations', () => ({ conversations: {} }));
vi.mock('@serverless-saas/agent-schema/agents', () => ({ agents: {} }));
vi.mock('@serverless-saas/agent-schema/personas', () => ({ personas: {} }));
vi.mock('@serverless-saas/permissions', () => ({ hasPermission: () => true }));

function appWithContext() {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
        c.set('requestContext', {
            tenant: { id: 'tenant-1' },
            permissions: [{ resource: 'conversations', action: 'update' }],
        });
        c.set('userId', 'user-1');
        await next();
    });
    return app;
}

function mockDb(db: any, existingMetadata: unknown) {
    const setSpy = vi.fn().mockReturnValue({ where: async () => undefined });
    db.update.mockReturnValue({ set: setSpy });
    let call = 0;
    db.select.mockImplementation(() => {
        const isFirst = call++ === 0;
        const rows = isFirst
            ? [{ id: 'conv-1', metadata: existingMetadata }]
            : [{ id: 'conv-1', metadata: existingMetadata, agent: { id: 'a1', name: 'A', type: 'platform', persona: null } }];
        const terminal = { where: () => ({ limit: async () => rows }) };
        return { from: () => ({ ...terminal, innerJoin: () => ({ leftJoin: () => terminal }) }) };
    });
    return setSpy;
}

async function patch(body: unknown, existingMetadata: unknown = null) {
    const { db } = await import('@serverless-saas/database/client');
    vi.clearAllMocks();
    const setSpy = mockDb(db, existingMetadata);
    const { conversationsRoutes } = await import('../routes/conversations');
    const app = appWithContext();
    app.route('/conversations', conversationsRoutes);
    const res = await app.request('/conversations/conv-1', {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
    });
    return { res, setSpy };
}

const SKILL = {
    installId: '11111111-1111-4111-8111-111111111111',
    skillId: '22222222-2222-4222-8222-222222222222',
    name: 'UGC Ad Production',
};

describe('PATCH /conversations/:id — invokedSkills', () => {
    beforeEach(() => vi.clearAllMocks());

    it('persists the list under metadata.invokedSkills', async () => {
        const { res, setSpy } = await patch({ invokedSkills: [SKILL] });
        expect(res.status).toBe(200);
        expect(setSpy.mock.calls[0][0].metadata).toEqual({ invokedSkills: [SKILL] });
    });

    it('clears the list when given null', async () => {
        const { res, setSpy } = await patch({ invokedSkills: null }, { invokedSkills: [SKILL] });
        expect(res.status).toBe(200);
        expect(setSpy.mock.calls[0][0].metadata).toEqual({});
    });

    it('merges into metadata rather than overwriting it', async () => {
        const { setSpy } = await patch({ invokedSkills: [SKILL] }, { allowMode: 'auto', testSkillInstallId: SKILL.installId });
        expect(setSpy.mock.calls[0][0].metadata).toEqual({
            allowMode: 'auto', testSkillInstallId: SKILL.installId, invokedSkills: [SKILL],
        });
    });

    it('rejects a non-uuid installId', async () => {
        const { res } = await patch({ invokedSkills: [{ ...SKILL, installId: 'nope' }] });
        expect(res.status).toBe(400);
    });

    it('rejects more than 8 invoked skills', async () => {
        const nine = Array.from({ length: 9 }, () => SKILL);
        const { res } = await patch({ invokedSkills: nine });
        expect(res.status).toBe(400);
    });
});
