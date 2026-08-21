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
        <div className="flex items-baseline justify-between gap-4 py-2.5">
            <span
                className={cn(
                    "font-medium capitalize",
                    hasAccess ? "text-foreground" : "text-muted-foreground/60"
                )}
            >
                {resource.replace(/_/g, " ")}
            </span>
            <span className="flex items-center gap-1 text-sm">
                {hasAccess ? (
                    ordered.map((action, i) => {
                        const perm = byAction.get(action);
                        if (!perm) return null;
                        const isSelected = selected.includes(perm.id);
                        return (
                            <span key={perm.id} className="flex items-center gap-1">
                                {i > 0 && <span className="text-muted-foreground/30">·</span>}
                                <button
                                    type="button"
                                    disabled={disabled}
                                    onClick={() => handleToggle(action)}
                                    className={cn(
                                        "rounded-md px-1.5 py-0.5 capitalize transition-colors",
                                        isSelected
                                            ? "bg-muted text-foreground hover:bg-muted/70"
                                            : "text-muted-foreground/40 hover:text-muted-foreground",
                                        disabled && "pointer-events-none opacity-60"
                                    )}
                                >
                                    {action}
                                </button>
                            </span>
                        );
                    })
                ) : (
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={() => handleToggle(ordered[0])}
                        className={cn(
                            "text-muted-foreground/40 hover:text-muted-foreground",
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
