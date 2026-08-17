import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { agents } from '@serverless-saas/agent-schema/agents';
import { personas } from '@serverless-saas/agent-schema/personas';

const dbMock = vi.hoisted(() => ({
    select: vi.fn(),
}));

vi.mock('../db', () => ({ db: dbMock }));

function appWithContext() {
    const app = new Hono<any>();
    app.use('*', async (c, next) => {
        c.set('requestContext', {
            tenant: { id: 'tenant-1' },
            permissions: [{ resource: 'agents', action: 'read' }],
        });
        await next();
    });
    return app;
}

describe('GET /agents/:agentId/core-files', () => {
    beforeEach(() => vi.clearAllMocks());

    it('never returns file content for an official persona — only names + locked flag', async () => {
        dbMock.select.mockImplementation(() => ({
            from: (table: unknown) => {
                if (table === agents) {
                    return {
                        leftJoin: () => ({
                            where: () => ({
                                limit: async () => [{
                                    id: 'agent-1',
                                    isOfficial: true,
                                    identityFile: 'SECRET PROPRIETARY PROMPT',
                                    soulFile: 'SECRET',
                                    agentsFile: 'SECRET',
                                    bootstrapFile: 'SECRET',
                                    userFile: 'SECRET',
                                }],
                            }),
                        }),
                    };
                }
                throw new Error('unexpected select target');
            },
        }));

        const { agentCoreFilesRoutes } = await import('../routes/agent-core-files');
        const app = appWithContext();
        app.route('/agents', agentCoreFilesRoutes);

        const res = await app.request('/agents/agent-1/core-files');

        expect(res.status).toBe(200);
        const body = await res.json();
        const names = body.data.map((f: any) => f.name);
        expect(names).toEqual(['AGENTS.md', 'BOOTSTRAP.md', 'IDENTITY.md', 'SOUL.md', 'USER.md']);
        for (const file of body.data) {
            expect(file.locked).toBe(true);
            expect(file.content).toBeUndefined();
        }
        expect(JSON.stringify(body)).not.toContain('SECRET');
    });
});
