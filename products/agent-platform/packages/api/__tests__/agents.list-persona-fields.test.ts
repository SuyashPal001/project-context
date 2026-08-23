import { describe, it, expect, vi, beforeEach } from 'vitest';
import { personas } from '@serverless-saas/agent-schema/personas';

const dbMock = vi.hoisted(() => ({
    select: vi.fn(),
}));

vi.mock('../db', () => ({ db: dbMock }));

function mockAgentsListChain(rows: unknown[]) {
    let selectedColumns: Record<string, unknown> = {};
    dbMock.select.mockImplementation((columns: Record<string, unknown>) => {
        selectedColumns = columns;
        return {
            from: () => ({
                leftJoin: () => ({
                    where: () => ({ orderBy: async () => rows }),
                }),
            }),
        };
    });
    return () => selectedColumns;
}

describe('handleListAgents persona fields', () => {
    beforeEach(() => vi.clearAllMocks());

    it('includes the persona outcome image fields so AgentCard can render Skills/Outcomes like PersonaCard', async () => {
        const getSelectedColumns = mockAgentsListChain([]);

        const { handleListAgents } = await import('../routes/agents.crud');
        const c: any = {
            get: (key: string) => (key === 'requestContext' ? { tenant: { id: 't1' }, permissions: ['agents:read'] } : undefined),
            json: (body: unknown) => body,
        };
        await handleListAgents(c);

        const persona = getSelectedColumns().persona as Record<string, unknown>;
        expect(persona).toHaveProperty('exampleAssetUrl', personas.exampleAssetUrl);
        expect(persona).toHaveProperty('exampleCaption', personas.exampleCaption);
        expect(persona).toHaveProperty('exampleAssetUrl2', personas.exampleAssetUrl2);
        expect(persona).toHaveProperty('exampleCaption2', personas.exampleCaption2);
    });
});
