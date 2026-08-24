import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useMemo } from "react";
import type { FileRecord } from "../types";

export interface Breadcrumb {
    name: string;
    path: string;
}

export function useFilesQuery(prefix: string) {
    const { data: agentsData } = useQuery({
        queryKey: ['agents'],
        queryFn: () => api.get<{ data: { id: string; name: string; status: string }[] }>('/api/v1/agents'),
    });
    const defaultAgentId = agentsData?.data?.find(a => a.status === 'active')?.id ?? null;

    const { data: response, isLoading } = useQuery({
        queryKey: ['files', prefix],
        queryFn: async () => {
            const params = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
            return api.get<{ data: FileRecord[] }>(`/api/v1/files${params}`);
        },
        refetchInterval: 5000,
    });

    const breadcrumbs = useMemo<Breadcrumb[]>(() => {
        if (!prefix) return [];
        const parts = prefix.split('/').filter(Boolean);
        return parts.map((part, index) => ({
            name: part,
            path: parts.slice(0, index + 1).join('/') + '/'
        }));
    }, [prefix]);

    const { virtualFolders, files, officeCodes } = useMemo(() => {
        const allFiles = response?.data || [];
        const folders = new Set<string>();
        const directFiles: FileRecord[] = [];

        allFiles.forEach(file => {
            if (prefix && !file.key.startsWith(prefix)) return;
            const relativePath = prefix ? file.key.substring(prefix.length) : file.key;
            if (relativePath.includes('/')) {
                const folderName = relativePath.split('/')[0];
                if (folderName) folders.add(folderName);
            } else {
                directFiles.push(file);
            }
        });

        return {
            virtualFolders: Array.from(folders).sort(),
            officeCodes: Array.from(new Set(allFiles.map(f => f.officeCode).filter(Boolean))).sort() as string[],
            files: directFiles.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        };
    }, [response?.data, prefix]);

    return {
        allFiles: response?.data ?? [],
        files,
        virtualFolders,
        officeCodes,
        breadcrumbs,
        isLoading,
        defaultAgentId,
    };
}
