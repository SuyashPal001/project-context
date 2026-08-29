import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface StorageUsage {
    usedBytes: number;
    limitBytes: number;
    percent: number;
    unlimited: boolean;
}

/**
 * Storage usage for the current tenant. Only ever rendered above 80% — see
 * shouldShowMeter — so this is deliberately not polled: it refetches when Drive
 * mounts, which is often enough for a ceiling nobody is supposed to be near.
 */
export function useStorageUsage(): StorageUsage | null {
    const { data } = useQuery({
        queryKey: ['storage-usage'],
        queryFn: () => api.get<{ data: StorageUsage }>('/api/v1/files/usage'),
    });
    return data?.data ?? null;
}
