"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { PermissionCategoryRow } from "./PermissionCategoryRow";

export interface Permission {
    id: string;
    resource: string;
    action: string;
    description: string | null;
}

interface Props {
    selected: string[];
    onChange: (ids: string[]) => void;
    disabled?: boolean;
}

export function PermissionPicker({ selected, onChange, disabled }: Props) {
    const { data, isLoading } = useQuery<{ data: Permission[] }>({
        queryKey: ["permissions-all"],
        queryFn: () => api.get("/api/v1/roles/permissions/all"),
        staleTime: 5 * 60 * 1000,
    });

    if (isLoading) {
        return (
            <div className="space-y-3">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
        );
    }

    const permissions = data?.data ?? [];
    const grouped: Record<string, Permission[]> = {};
    for (const p of permissions) {
        (grouped[p.resource] ??= []).push(p);
    }

    const resources = Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b));
    const categoriesWithAccess = resources.filter(([, perms]) => perms.some(p => selected.includes(p.id))).length;

    const applyToggle = (toAdd: string[], toRemove: string[]) => {
        const removeSet = new Set(toRemove);
        onChange([...new Set([...selected.filter(id => !removeSet.has(id)), ...toAdd])]);
    };

    return (
        <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
                {categoriesWithAccess} of {resources.length} categories have access
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-12">
                {resources.map(([resource, perms]) => (
                    <PermissionCategoryRow
                        key={resource}
                        resource={resource}
                        permissions={perms}
                        selected={selected}
                        disabled={disabled}
                        onToggle={applyToggle}
                    />
                ))}
            </div>
        </div>
    );
}
