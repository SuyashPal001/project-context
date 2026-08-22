import { describe, it, expect, vi, beforeEach } from 'vitest';
import { personas } from '@serverless-saas/agent-schema/personas';

const dbMock = vi.hoisted(() => ({
    select: vi.fn(),
}));

vi.mock('../db', () => ({ db: dbMock }));

describe('GET /agents/personas', () => {
    beforeEach(() => vi.clearAllMocks());

    it('includes exampleAssetUrl/exampleCaption for the marketplace card grid', async () => {
        let selectedColumns: Record<string, unknown> = {};
        dbMock.select.mockImplementation((columns: Record<string, unknown>) => {
            selectedColumns = columns;
            return { from: () => ({ where: async () => [] }) };
        });

        const { agentsRoutes } = await import('../routes/agents');
        await agentsRoutes.request('/personas');

        expect(selectedColumns).toHaveProperty('exampleAssetUrl', personas.exampleAssetUrl);
        expect(selectedColumns).toHaveProperty('exampleCaption', personas.exampleCaption);
    });

    it('includes exampleAssetUrl2/exampleCaption2 for the second outcome image', async () => {
        let selectedColumns: Record<string, unknown> = {};
        dbMock.select.mockImplementation((columns: Record<string, unknown>) => {
            selectedColumns = columns;
            return { from: () => ({ where: async () => [] }) };
        });

        const { agentsRoutes } = await import('../routes/agents');
        await agentsRoutes.request('/personas');

        expect(selectedColumns).toHaveProperty('exampleAssetUrl2', personas.exampleAssetUrl2);
        expect(selectedColumns).toHaveProperty('exampleCaption2', personas.exampleCaption2);
    });
});
