import { describe, it, expect, vi, beforeEach } from 'vitest';
import { personas } from '@serverless-saas/agent-schema/personas';

const dbMock = vi.hoisted(() => ({
    select: vi.fn(),
}));

vi.mock('../db', () => ({ db: dbMock }));

function mockDefaultProviderThenPersonas(personaRows: unknown[], defaultProviderRow: unknown) {
    let selectedPersonaColumns: Record<string, unknown> = {};
    dbMock.select
        .mockImplementationOnce(() => ({
            from: () => ({
                where: () => ({ limit: async () => (defaultProviderRow ? [defaultProviderRow] : []) }),
            }),
        }))
        .mockImplementationOnce((columns: Record<string, unknown>) => {
            selectedPersonaColumns = columns;
            return { from: () => ({ where: async () => personaRows }) };
        });
    return () => selectedPersonaColumns;
}

describe('GET /agents/personas', () => {
    beforeEach(() => vi.clearAllMocks());

    it('includes exampleAssetUrl/exampleCaption for the marketplace card grid', async () => {
        const getSelectedColumns = mockDefaultProviderThenPersonas([], undefined);

        const { agentsRoutes } = await import('../routes/agents');
        await agentsRoutes.request('/personas');

        expect(getSelectedColumns()).toHaveProperty('exampleAssetUrl', personas.exampleAssetUrl);
        expect(getSelectedColumns()).toHaveProperty('exampleCaption', personas.exampleCaption);
    });

    it('includes exampleAssetUrl2/exampleCaption2 for the second outcome image', async () => {
        const getSelectedColumns = mockDefaultProviderThenPersonas([], undefined);

        const { agentsRoutes } = await import('../routes/agents');
        await agentsRoutes.request('/personas');

        expect(getSelectedColumns()).toHaveProperty('exampleAssetUrl2', personas.exampleAssetUrl2);
        expect(getSelectedColumns()).toHaveProperty('exampleCaption2', personas.exampleCaption2);
    });

    it('stamps every persona with the platform default model display name as defaultModel', async () => {
        mockDefaultProviderThenPersonas(
            [{ id: 'p1', slug: 'disco', name: 'Disco' }],
            { displayName: 'Gemini 2.5 Flash' },
        );

        const { agentsRoutes } = await import('../routes/agents');
        const res = await agentsRoutes.request('/personas');
        const body = await res.json();

        expect(body.personas[0].defaultModel).toBe('Gemini 2.5 Flash');
    });

    it('returns defaultModel null when no platform default provider is configured', async () => {
        mockDefaultProviderThenPersonas(
            [{ id: 'p1', slug: 'disco', name: 'Disco' }],
            undefined,
        );

        const { agentsRoutes } = await import('../routes/agents');
        const res = await agentsRoutes.request('/personas');
        const body = await res.json();

        expect(body.personas[0].defaultModel).toBeNull();
    });
});
