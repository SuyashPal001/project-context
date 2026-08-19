import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
    api: { get: vi.fn(async () => ({ data: [{ id: 'a1', type: 'video', filename: 'clip.mp4', createdAt: '2026-08-01T00:00:00Z', sourceMessageId: 'm1' }] })) },
}));

describe('useConversationAssets query key', () => {
    it('builds the assets endpoint path from the conversation id', async () => {
        const { api } = await import('@/lib/api');
        const { assetsQueryOptions } = await import('./useConversationAssets');

        const options = assetsQueryOptions('conv-1');
        await options.queryFn();

        expect(api.get).toHaveBeenCalledWith('/api/v1/conversations/conv-1/assets');
        expect(options.queryKey).toEqual(['conversation-assets', 'conv-1']);
    });
});
