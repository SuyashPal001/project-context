import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '@/lib/api';

function res(status: number, body: unknown = {}) {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
    fetchMock.mockReset();
    (globalThis as any).fetch = fetchMock;
});

describe('firePersonaAgent', () => {
    it('calls DELETE /agents/:id, not the old PATCH-to-paused endpoint', async () => {
        fetchMock.mockResolvedValueOnce(res(200, { success: true }));
        const { firePersonaAgent } = await import('./actions');

        await firePersonaAgent('agent-1');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toContain('/agents/agent-1');
        expect(options.method).toBe('DELETE');
    });

    it('surfaces a 409 dependency-check error so the UI can show the confirmation', async () => {
        fetchMock.mockResolvedValueOnce(res(409, { shiftsCount: 2, teamsCount: 0 }));
        const { firePersonaAgent } = await import('./actions');

        await expect(firePersonaAgent('agent-1')).rejects.toMatchObject({
            status: 409,
            data: { shiftsCount: 2, teamsCount: 0 },
        });
    });

    it('passes force:true through to bypass the dependency check on retry', async () => {
        fetchMock.mockResolvedValueOnce(res(200, { success: true }));
        const { firePersonaAgent } = await import('./actions');

        await firePersonaAgent('agent-1', { force: true });

        const [, options] = fetchMock.mock.calls[0];
        expect(JSON.parse(options.body)).toEqual({ force: true });
    });
});
