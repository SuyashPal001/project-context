'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface ComposioApp {
    appName: string;
    label: string;
    description: string;
    scopes: readonly string[];
    category: string;
    connected: boolean;
}

interface ComposioAppsResponse {
    apps: ComposioApp[];
}

export function useComposioIntegrations() {
    const { data, isLoading, isError, refetch } = useQuery<ComposioAppsResponse>({
        queryKey: ['composio-integrations'],
        queryFn: () => api.get<ComposioAppsResponse>('/api/v1/integrations/composio/apps'),
        staleTime: 30_000,
    });

    const apps = data?.apps ?? [];

    const isConnected = (appName: string): boolean =>
        apps.some((a) => a.appName === appName && a.connected);

    return { apps, isLoading, isError, refetch, isConnected };
}
