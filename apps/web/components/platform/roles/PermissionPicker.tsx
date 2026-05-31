"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

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

    const toggle = (id: string) => {
        onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
    };

    const toggleGroup = (ids: string[]) => {
        const allOn = ids.every(id => selected.includes(id));
        onChange(allOn ? selected.filter(id => !ids.includes(id)) : [...new Set([...selected, ...ids])]);
    };

    return (
        <div className="space-y-4">
            {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([resource, perms]) => {
                const groupIds = perms.map(p => p.id);
                const allChecked = groupIds.every(id => selected.includes(id));
                const someChecked = groupIds.some(id => selected.includes(id));

                return (
                    <div key={resource} className="rounded-lg border border-border p-3 space-y-2">
                        <div className="flex items-center gap-2">
                            <Checkbox
                                id={`group-${resource}`}
                                checked={allChecked ? true : someChecked ? "indeterminate" : false}
                                onCheckedChange={() => toggleGroup(groupIds)}
                                disabled={disabled}
                            />
                            <Label htmlFor={`group-${resource}`} className="font-semibold capitalize cursor-pointer">
                                {resource.replace(/_/g, " ")}
                            </Label>
                        </div>
                        <div className="grid grid-cols-2 gap-1.5 pl-6">
                            {perms.map(p => (
                                <div key={p.id} className="flex items-center gap-2">
                                    <Checkbox
                                        id={p.id}
                                        checked={selected.includes(p.id)}
                                        onCheckedChange={() => toggle(p.id)}
                                        disabled={disabled}
                                    />
                                    <Label htmlFor={p.id} className="text-sm capitalize cursor-pointer text-muted-foreground">
                                        {p.action}
                                    </Label>
                                </div>
                            ))}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
