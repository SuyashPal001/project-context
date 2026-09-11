import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

/**
 * A folder grant is the only thing standing between the agent and every file in
 * the tenant, so what actually gets written matters more than what the response
 * echoes back. With a mocked database, asserting the response body would only
 * assert the mock — these tests assert the payload handed to db.update().set()
 * instead, which is the real merge behaviour.
 */

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

/**
 * The handler makes two differently-shaped selects: the ownership lookup
 * (from → where → limit, no `metadata` any more — Fix 4 merges in SQL against
 * the live column instead of reading it here) and the response read (from →
 * innerJoin → leftJoin → where → limit).
 */
function mockDb(db: any) {
    const setSpy = vi.fn().mockReturnValue({ where: async () => undefined });
    db.update.mockReturnValue({ set: setSpy });

    let call = 0;
    db.select.mockImplementation(() => {
        const isFirst = call++ === 0;
        const rows = isFirst
            ? [{ id: 'conv-1' }]
            : [{ id: 'conv-1', metadata: {}, agent: { id: 'a1', name: 'A', type: 'platform', persona: null } }];
        const terminal = { where: () => ({ limit: async () => rows }) };
        return {
            from: () => ({
                ...terminal,
                innerJoin: () => ({ leftJoin: () => terminal }),
            }),
        };
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

// The metadata value handed to .set() is a drizzle SQL fragment (Fix 4: an
// in-SQL merge, `coalesce(metadata, '{}'::jsonb) || <patch> - 'key'...`), not
// a plain object — this renders that fragment back to a plain string so the
// tests can assert on its shape instead of comparing it to a JS object.
function renderSql(expr: any): string {
    if (expr && Array.isArray(expr.value)) return expr.value.join('');
    if (expr && Array.isArray(expr.queryChunks)) return expr.queryChunks.map(renderSql).join('');
    if (typeof expr === 'string') return expr;
    return '';
}

describe('PATCH /conversations/:id — folderScope grant', () => {
    beforeEach(() => vi.clearAllMocks());

    it('persists a prefix under metadata.folderScope via a SQL merge against the live column', async () => {
        const { res, setSpy } = await patch({ folderScope: { prefix: 'new/' } });
        expect(res.status).toBe(200);
        const metadata = setSpy.mock.calls[0][0].metadata;
        expect(Array.isArray(metadata?.queryChunks)).toBe(true);
        const rendered = renderSql(metadata);
        expect(rendered).toContain('coalesce(');
        expect(rendered).toContain(JSON.stringify({ folderScope: { prefix: 'new/' } }));
        expect(rendered).not.toContain(' - ');
    });

    it('clears the grant when given null by removing the key in SQL', async () => {
        const { res, setSpy } = await patch({ folderScope: null });
        expect(res.status).toBe(200);
        const rendered = renderSql(setSpy.mock.calls[0][0].metadata);
        expect(rendered).toContain('coalesce(');
        expect(rendered).toContain(' - folderScope');
    });

    it('merges other set keys and removed keys into one SQL expression, never overwriting the whole object', async () => {
        // A JS read-merge-write here would silently destroy whatever else the
        // product stores on a conversation if it changed concurrently — Fix 4
        // merges in SQL against the live column instead.
        const { setSpy } = await patch({ folderScope: { prefix: 'new/' }, allowMode: null });
        const rendered = renderSql(setSpy.mock.calls[0][0].metadata);
        expect(rendered).toContain(JSON.stringify({ folderScope: { prefix: 'new/' } }));
        expect(rendered).toContain(' - allowMode');
    });

    it('leaves metadata untouched when folderScope is not part of the patch', async () => {
        const { setSpy } = await patch({ title: 'Renamed' });
        expect(setSpy.mock.calls[0][0]).not.toHaveProperty('metadata');
    });

    it('rejects a prefix containing traversal', async () => {
        const { res } = await patch({ folderScope: { prefix: '../other/' } });
        expect(res.status).toBe(400);
    });

    it('rejects a prefix that does not end in a slash', async () => {
        // "new" would match a sibling "newer/" under `like prefix || '%'`.
        const { res } = await patch({ folderScope: { prefix: 'new' } });
        expect(res.status).toBe(400);
    });

    it('rejects an absolute prefix', async () => {
        const { res } = await patch({ folderScope: { prefix: '/new/' } });
        expect(res.status).toBe(400);
    });
});
