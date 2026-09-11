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

function mockDb(db: any) {
    const setSpy = vi.fn().mockReturnValue({ where: async () => undefined });
    db.update.mockReturnValue({ set: setSpy });
    let call = 0;
    db.select.mockImplementation(() => {
        const isFirst = call++ === 0;
        // The route no longer selects `metadata` on the ownership check — the
        // merge now happens in SQL against the live column, not against a
        // value read here. The row shape below still carries `metadata` so
        // this mock also serves the post-update refetch.
        const rows = isFirst
            ? [{ id: 'conv-1' }]
            : [{ id: 'conv-1', metadata: {}, agent: { id: 'a1', name: 'A', type: 'platform', persona: null } }];
        const terminal = { where: () => ({ limit: async () => rows }) };
        return { from: () => ({ ...terminal, innerJoin: () => ({ leftJoin: () => terminal }) }) };
    });
    return setSpy;
}

async function patch(body: unknown) {
    const { db } = await import('@serverless-saas/database/client');
    vi.clearAllMocks();
    const setSpy = mockDb(db);
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

// The metadata value handed to .set() is a drizzle SQL fragment (built with
// the `sql` template), not a plain object — Fix 4 replaced read-JS-merge-write
// with an in-SQL merge (`coalesce(metadata, '{}'::jsonb) || <patch> - 'key'...`)
// so a concurrent write to another metadata key is never lost. This renders
// that fragment back to a plain string so the tests can assert on its shape.
function renderSql(expr: any): string {
    if (expr && Array.isArray(expr.value)) return expr.value.join('');
    if (expr && Array.isArray(expr.queryChunks)) return expr.queryChunks.map(renderSql).join('');
    if (typeof expr === 'string') return expr;
    return '';
}

const SKILL = {
    installId: '11111111-1111-4111-8111-111111111111',
    skillId: '22222222-2222-4222-8222-222222222222',
    name: 'UGC Ad Production',
};

describe('PATCH /conversations/:id — invokedSkills', () => {
    beforeEach(() => vi.clearAllMocks());

    it('persists the list under metadata.invokedSkills via a SQL merge, not a plain object', async () => {
        const { res, setSpy } = await patch({ invokedSkills: [SKILL] });
        expect(res.status).toBe(200);
        const metadata = setSpy.mock.calls[0][0].metadata;
        // Not read-merge-write: the value is a SQL fragment, not a plain object.
        expect(metadata).not.toEqual({ invokedSkills: [SKILL] });
        expect(Array.isArray(metadata?.queryChunks)).toBe(true);
        const rendered = renderSql(metadata);
        expect(rendered).toContain("coalesce(");
        expect(rendered).toContain("'{}'::jsonb) || ");
        expect(rendered).toContain(JSON.stringify({ invokedSkills: [SKILL] }));
        expect(rendered).toContain('::jsonb');
        expect(rendered).not.toContain(' - ');
    });

    it('clears the list when given null by removing the key in SQL', async () => {
        const { res, setSpy } = await patch({ invokedSkills: null });
        expect(res.status).toBe(200);
        const rendered = renderSql(setSpy.mock.calls[0][0].metadata);
        expect(rendered).toContain("coalesce(");
        expect(rendered).toContain(" - invokedSkills");
    });

    it('merges other set keys and removed keys into one SQL expression', async () => {
        const { setSpy } = await patch({ invokedSkills: [SKILL], allowMode: null });
        const rendered = renderSql(setSpy.mock.calls[0][0].metadata);
        // Merges the set fields via `||` against the live column...
        expect(rendered).toContain(JSON.stringify({ invokedSkills: [SKILL] }));
        // ...and removes the nulled key via `- 'key'`, chained onto the same
        // expression rather than overwriting the whole object.
        expect(rendered).toContain(' - allowMode');
    });

    it('never reads conversation metadata off the ownership-check select', async () => {
        const { db } = await import('@serverless-saas/database/client');
        vi.clearAllMocks();
        mockDb(db);
        const selectSpy = db.select as ReturnType<typeof vi.fn>;
        const { conversationsRoutes } = await import('../routes/conversations');
        const app = appWithContext();
        app.route('/conversations', conversationsRoutes);
        await app.request('/conversations/conv-1', {
            method: 'PATCH',
            body: JSON.stringify({ invokedSkills: [SKILL] }),
            headers: { 'Content-Type': 'application/json' },
        });
        // First select call is the ownership check — it must not ask for
        // `metadata` any more, since the merge no longer reads it in JS.
        const firstCallArg = selectSpy.mock.calls[0]?.[0];
        if (firstCallArg && typeof firstCallArg === 'object') {
            expect(Object.keys(firstCallArg)).not.toContain('metadata');
        }
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
