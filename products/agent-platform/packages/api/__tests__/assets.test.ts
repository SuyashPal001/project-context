import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const dbMock = vi.hoisted(() => ({
    select: vi.fn(),
}));

vi.mock('../db', () => ({ db: dbMock }));
vi.mock('@serverless-saas/permissions', () => ({ hasPermission: () => true }));

// Hono context vars (`c.get('requestContext')`, `c.get('userId')`) are not
// settable via the third argument to `.request()` — the codebase's
// established pattern (see __tests__/conversations.persona.test.ts) wraps
// the router under test in an app that sets them via middleware first.
function appWithContext() {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
        c.set('requestContext', { tenant: { id: 'tenant-1' }, permissions: ['conversations:read'] });
        c.set('userId', 'user-1');
        await next();
    });
    return app;
}

describe('GET /conversations/:id/assets', () => {
    beforeEach(() => vi.clearAllMocks());

    it('maps attachments and artifactRef from messages into a flat asset list', async () => {
        const conversationRow = { id: 'conv-1', tenantId: 'tenant-1', userId: 'user-1' };
        const messageRows = [
            {
                id: 'msg-1',
                createdAt: new Date('2026-08-01T00:00:00Z'),
                attachments: [{ fileId: 'file-1', name: 'clip.mp4', type: 'video/mp4', size: 1024 }],
                artifactRef: null,
            },
            {
                id: 'msg-2',
                createdAt: new Date('2026-08-02T00:00:00Z'),
                attachments: null,
                artifactRef: { type: 'prd', entityId: 'prd-1', title: 'Onboarding PRD' },
            },
            {
                id: 'msg-3',
                createdAt: new Date('2026-08-03T00:00:00Z'),
                attachments: null,
                artifactRef: null,
            },
        ];

        let call = 0;
        dbMock.select.mockImplementation(() => ({
            from: () => ({
                where: (...args: unknown[]) => {
                    call += 1;
                    // First select() is resolveConversation's lookup, second is the messages list.
                    if (call === 1) {
                        return { limit: async () => [conversationRow] };
                    }
                    return { orderBy: async () => messageRows };
                },
            }),
        }));

        const { assetsRoutes } = await import('../routes/assets');
        const app = appWithContext().route('/conversations', assetsRoutes);
        const res = await app.request('/conversations/conv-1/assets');
        const body = await res.json() as { data: Array<{ id: string; type: string; filename: string }> };

        expect(res.status).toBe(200);
        expect(body.data).toEqual([
            expect.objectContaining({ id: 'file-1', type: 'video', filename: 'clip.mp4', sourceMessageId: 'msg-1' }),
            expect.objectContaining({ id: 'prd-1', type: 'prd', filename: 'Onboarding PRD', sourceMessageId: 'msg-2' }),
        ]);
    });

    it('classifies pdf and docx attachments as their own types, not the generic file fallback', async () => {
        const conversationRow = { id: 'conv-1', tenantId: 'tenant-1', userId: 'user-1' };
        const messageRows = [
            {
                id: 'msg-1',
                createdAt: new Date('2026-08-01T00:00:00Z'),
                attachments: [
                    { fileId: 'file-1', name: 'report.pdf', type: 'application/pdf', size: 1024 },
                    { fileId: 'file-2', name: 'notes.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 2048 },
                ],
                artifactRef: null,
            },
        ];

        let call = 0;
        dbMock.select.mockImplementation(() => ({
            from: () => ({
                where: (...args: unknown[]) => {
                    call += 1;
                    if (call === 1) {
                        return { limit: async () => [conversationRow] };
                    }
                    return { orderBy: async () => messageRows };
                },
            }),
        }));

        const { assetsRoutes } = await import('../routes/assets');
        const app = appWithContext().route('/conversations', assetsRoutes);
        const res = await app.request('/conversations/conv-1/assets');
        const body = await res.json() as { data: Array<{ id: string; type: string }> };

        expect(body.data).toEqual([
            expect.objectContaining({ id: 'file-1', type: 'pdf' }),
            expect.objectContaining({ id: 'file-2', type: 'docx' }),
        ]);
    });

    it('skips a malformed artifactRef (missing entityId) and produces zero assets from that message', async () => {
        const conversationRow = { id: 'conv-1', tenantId: 'tenant-1', userId: 'user-1' };
        const messageRows = [
            {
                id: 'msg-1',
                createdAt: new Date('2026-08-01T00:00:00Z'),
                attachments: null,
                artifactRef: { type: 'prd', title: 'Missing entityId PRD' },
            },
        ];

        let call = 0;
        dbMock.select.mockImplementation(() => ({
            from: () => ({
                where: (...args: unknown[]) => {
                    call += 1;
                    if (call === 1) {
                        return { limit: async () => [conversationRow] };
                    }
                    return { orderBy: async () => messageRows };
                },
            }),
        }));

        const { assetsRoutes } = await import('../routes/assets');
        const app = appWithContext().route('/conversations', assetsRoutes);
        const res = await app.request('/conversations/conv-1/assets');
        const body = await res.json() as { data: unknown[] };

        expect(res.status).toBe(200);
        expect(body.data).toEqual([]);
    });

    it('returns 404 when the conversation does not belong to this tenant/user', async () => {
        dbMock.select.mockImplementation(() => ({
            from: () => ({ where: () => ({ limit: async () => [] }) }),
        }));

        const { assetsRoutes } = await import('../routes/assets');
        const app = appWithContext().route('/conversations', assetsRoutes);
        const res = await app.request('/conversations/conv-missing/assets');

        expect(res.status).toBe(404);
    });
});
