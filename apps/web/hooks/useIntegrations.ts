'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface Integration {
    id: string;
    provider: string;
    status: string;
    permissions: string[];
    createdAt: string;
}

interface IntegrationsResponse {
    integrations: Integration[];
}

export function useIntegrations() {
    const { data, isLoading, isError, refetch } = useQuery<IntegrationsResponse>({
        queryKey: ['integrations'],
        queryFn: () => api.get<IntegrationsResponse>('/api/v1/integrations'),
    });

    const integrations = data?.integrations ?? [];

    const isConnected = (provider: string): boolean =>
        integrations.some((i) => i.provider === provider && i.status === 'active');

    const getIntegration = (provider: string): Integration | undefined =>
        integrations.find((i) => i.provider === provider);

    return { integrations, isLoading, isError, refetch, isConnected, getIntegration };
}
