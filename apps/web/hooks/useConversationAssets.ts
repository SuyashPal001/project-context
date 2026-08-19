import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Asset, AssetsResponse } from '@/types/assets';

export function assetsQueryOptions(conversationId: string) {
    return {
        queryKey: ['conversation-assets', conversationId] as const,
        queryFn: () => api.get<AssetsResponse>(`/api/v1/conversations/${conversationId}/assets`),
    };
}

export function useConversationAssets(conversationId: string | undefined) {
    const query = useQuery({
        ...(conversationId ? assetsQueryOptions(conversationId) : { queryKey: ['conversation-assets', 'none'] as const, queryFn: async () => ({ data: [] as Asset[] }) }),
        enabled: !!conversationId,
    });

    return {
        assets: query.data?.data ?? [],
        isLoading: query.isLoading,
        refetch: query.refetch,
    };
}
