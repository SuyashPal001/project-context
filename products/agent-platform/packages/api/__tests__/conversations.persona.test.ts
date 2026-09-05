import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

/**
 * Final whole-branch review, Finding 3 — GET /conversations/:id selects
 * `agent: { persona: { id, name, tagline } }`, a THREE-level
 * nested path. Drizzle's left-join null-collapsing only nullifies a nested
 * selected object when its field path has length === 2, so a persona-less
 * agent (the common case — left join finds no matching persona row) came back
 * as `agent.persona = { id: null, name: null, tagline: null }` instead of
 * `agent.persona = null`, contradicting the frontend's
 * `persona: PersonaSummary | null` contract.
 */

vi.mock('@serverless-saas/database/client', () => ({ db: { select: vi.fn() } }));
vi.mock('@serverless-saas/agent-schema/conversations', () => ({ conversations: {} }));
vi.mock('@serverless-saas/agent-schema/agents', () => ({ agents: {} }));
vi.mock('@serverless-saas/agent-schema/personas', () => ({ personas: { id: 'p.id', name: 'p.name', tagline: 'p.tagline', slug: 'p.slug', suggestedPrompts: 'p.suggestedPrompts' } }));
vi.mock('@serverless-saas/permissions', () => ({ hasPermission: () => true }));

function appWithContext() {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
        c.set('requestContext', { tenant: { id: 'tenant-1' }, permissions: [{ resource: 'conversations', action: 'read' }] });
        c.set('userId', 'user-1');
        await next();
    });
    return app;
}

function mockSelectChain(db: any, rows: unknown[]) {
    db.select.mockReturnValue({
        from: () => ({
            innerJoin: () => ({
                leftJoin: () => ({
                    where: () => ({ limit: async () => rows }),
                }),
            }),
        }),
    });
}

describe('GET /conversations/:id — persona null-collapsing', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns agent.persona === null for an agent with no persona (not an all-null object)', async () => {
        const { db } = await import('@serverless-saas/database/client');
        mockSelectChain(db, [{
            id: 'conv-1',
            tenantId: 'tenant-1',
            agentId: 'agent-1',
            userId: 'user-1',
            title: null,
            status: 'active',
            needsHuman: false,
            metadata: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            agent: {
                id: 'agent-1',
                name: 'Disco',
                type: 'platform',
                // What the raw left-join select returns for a persona-less agent —
                // all fields present but null, since the nesting is 3 levels deep.
                persona: { id: null, name: null, tagline: null },
            },
        }]);

        const { conversationsRoutes } = await import('../routes/conversations');
        const app = appWithContext();
        app.route('/conversations', conversationsRoutes);

        const res = await app.request('/conversations/conv-1');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.agent.persona).toBeNull();
    });

    it('preserves a real persona object when the agent has one assigned', async () => {
        const { db } = await import('@serverless-saas/database/client');
        mockSelectChain(db, [{
            id: 'conv-2',
            tenantId: 'tenant-1',
            agentId: 'agent-2',
            userId: 'user-1',
            title: null,
            status: 'active',
            needsHuman: false,
            metadata: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            agent: {
                id: 'agent-2',
                name: 'Saarthi PM',
                type: 'custom',
                persona: { id: 'persona-1', name: 'Saarthi', tagline: 'Your PM copilot' },
            },
        }]);

        const { conversationsRoutes } = await import('../routes/conversations');
        const app = appWithContext();
        app.route('/conversations', conversationsRoutes);

        const res = await app.request('/conversations/conv-2');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.agent.persona).toEqual({ id: 'persona-1', name: 'Saarthi', tagline: 'Your PM copilot' });
    });

    it('includes persona slug and suggestedPrompts so the frontend can resolve welcome pills', async () => {
        const { db } = await import('@serverless-saas/database/client');
        mockSelectChain(db, [{
            id: 'conv-3',
            tenantId: 'tenant-1',
            agentId: 'agent-3',
            userId: 'user-1',
            title: null,
            status: 'active',
            needsHuman: false,
            metadata: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            agent: {
                id: 'agent-3',
                name: 'Producer',
                type: 'custom',
                persona: {
                    id: 'persona-3',
                    name: 'Producer',
                    tagline: 'I make music',
                    slug: 'producer',
                    suggestedPrompts: [{ icon: 'music', label: 'Make a beat', promptText: 'Make a lofi beat about ' }],
                },
            },
        }]);

        const { conversationsRoutes } = await import('../routes/conversations');
        const app = appWithContext();
        app.route('/conversations', conversationsRoutes);

        const res = await app.request('/conversations/conv-3');
        expect(res.status).toBe(200);

        // Verify that db.select was called with a select object that includes slug and suggestedPrompts
        expect((db.select as any).mock.calls[0][0].agent.persona).toMatchObject({
            slug: 'p.slug',
            suggestedPrompts: 'p.suggestedPrompts',
        });

        const body = await res.json();
        expect(body.data.agent.persona.slug).toBe('producer');
        expect(body.data.agent.persona.suggestedPrompts).toEqual([
            { icon: 'music', label: 'Make a beat', promptText: 'Make a lofi beat about ' },
        ]);
    });
});
