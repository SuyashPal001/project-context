"use client";

import { cn } from "@/lib/utils";
import type { Permission } from "./PermissionPicker";

const ACTION_ORDER = ["create", "read", "update", "delete"];

// update implies read; delete implies read + update. Granting a lower level
// never implies the ones above it, and revoking a level revokes anything
// built on top of it.
const IMPLIED_BY: Record<string, string[]> = {
    update: ["read"],
    delete: ["read", "update"],
};

interface Props {
    resource: string;
    permissions: Permission[];
    selected: string[];
    disabled?: boolean;
    onToggle: (toAdd: string[], toRemove: string[]) => void;
}

export function PermissionCategoryRow({ resource, permissions, selected, disabled, onToggle }: Props) {
    const byAction = new Map(permissions.map(p => [p.action, p]));
    const ordered = [
        ...ACTION_ORDER.filter(a => byAction.has(a)),
        ...permissions.map(p => p.action).filter(a => !ACTION_ORDER.includes(a)),
    ];

    const hasAccess = permissions.some(p => selected.includes(p.id));

    const handleToggle = (action: string) => {
        const perm = byAction.get(action);
        if (!perm) return;

        const isSelected = selected.includes(perm.id);
        const toRemove = new Set<string>();
        const toAdd = new Set<string>();

        if (isSelected) {
            toRemove.add(perm.id);
            for (const [otherAction, deps] of Object.entries(IMPLIED_BY)) {
                if (deps.includes(action)) {
                    const otherPerm = byAction.get(otherAction);
                    if (otherPerm) toRemove.add(otherPerm.id);
                }
            }
        } else {
            toAdd.add(perm.id);
            for (const dep of IMPLIED_BY[action] ?? []) {
                const depPerm = byAction.get(dep);
                if (depPerm) toAdd.add(depPerm.id);
            }
        }

        onToggle([...toAdd], [...toRemove]);
    };

    return (
        <div className="flex items-center justify-between gap-4 py-2.5 border-b border-border/50 last:border-b-0">
            <span
                className={cn(
                    "text-base font-medium capitalize",
                    hasAccess ? "text-foreground" : "text-muted-foreground/60"
                )}
            >
                {resource.replace(/_/g, " ")}
            </span>
            <span className="flex items-center gap-6 text-base">
                {hasAccess ? (
                    ordered.map((action) => {
                        const perm = byAction.get(action);
                        if (!perm) return null;
                        const isSelected = selected.includes(perm.id);
                        return (
                            <button
                                key={perm.id}
                                type="button"
                                disabled={disabled}
                                onClick={() => handleToggle(action)}
                                className={cn(
                                    "flex items-center gap-2 capitalize transition-colors",
                                    isSelected ? "text-foreground" : "text-muted-foreground/70 hover:text-muted-foreground",
                                    disabled && "pointer-events-none opacity-60"
                                )}
                            >
                                <span
                                    className={cn(
                                        "flex h-4 w-4 items-center justify-center rounded-full border",
                                        isSelected ? "border-foreground" : "border-muted-foreground/30"
                                    )}
                                >
                                    {isSelected && <span className="h-2 w-2 rounded-full bg-foreground" />}
                                </span>
                                {action}
                            </button>
                        );
                    })
                ) : (
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={() => handleToggle(ordered[0])}
                        className={cn(
                            "text-muted-foreground/70 hover:text-muted-foreground",
                            disabled && "pointer-events-none opacity-60"
                        )}
                    >
                        No access
                    </button>
                )}
            </span>
        </div>
    );
}
