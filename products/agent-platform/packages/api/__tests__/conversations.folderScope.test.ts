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
 * The handler makes two differently-shaped selects: the ownership/metadata
 * lookup (from → where → limit) and the response read (from → innerJoin →
 * leftJoin → where → limit). One mock serves both by exposing every link.
 */
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
        return {
            from: () => ({
                ...terminal,
                innerJoin: () => ({ leftJoin: () => terminal }),
            }),
        };
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

describe('PATCH /conversations/:id — folderScope grant', () => {
    beforeEach(() => vi.clearAllMocks());

    it('persists a prefix under metadata.folderScope', async () => {
        const { res, setSpy } = await patch({ folderScope: { prefix: 'new/' } });
        expect(res.status).toBe(200);
        expect(setSpy.mock.calls[0][0].metadata).toEqual({ folderScope: { prefix: 'new/' } });
    });

    it('clears the grant when given null', async () => {
        const { res, setSpy } = await patch({ folderScope: null }, { folderScope: { prefix: 'old/' } });
        expect(res.status).toBe(200);
        expect(setSpy.mock.calls[0][0].metadata).toEqual({});
    });

    it('merges into metadata rather than overwriting it', async () => {
        // Losing an unrelated key here would silently destroy whatever else the
        // product later stores on a conversation.
        const { setSpy } = await patch({ folderScope: { prefix: 'new/' } }, { pinned: true });
        expect(setSpy.mock.calls[0][0].metadata).toEqual({ pinned: true, folderScope: { prefix: 'new/' } });
    });

    it('leaves metadata untouched when folderScope is not part of the patch', async () => {
        const { setSpy } = await patch({ title: 'Renamed' }, { pinned: true });
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
