"use client";

import type { UseFormReturn } from "react-hook-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
    PERMISSION_RESOURCES,
    PERMISSION_ACTIONS,
    type PermissionAction,
    type ApiKeyFormValues,
} from "./_config";

interface PermissionsStepProps {
    form: UseFormReturn<ApiKeyFormValues>;
    isSubmitting: boolean;
    onBack: () => void;
}

export function PermissionsStep({ form, isSubmitting, onBack }: PermissionsStepProps) {
    const selectedPermissions = form.watch("permissions");

    const togglePermission = (perm: string) => {
        const current = form.getValues("permissions");
        if (current.includes(perm)) {
            form.setValue("permissions", current.filter(p => p !== perm));
        } else {
            form.setValue("permissions", [...current, perm]);
        }
    };

    const toggleResource = (resource: string, actions: readonly string[], checked: boolean) => {
        const current = form.getValues("permissions");
        const resourcePerms = actions.map(a => `${resource}:${a}`);
        if (checked) {
            form.setValue("permissions", Array.from(new Set([...current, ...resourcePerms])));
        } else {
            form.setValue("permissions", current.filter(p => !resourcePerms.includes(p)));
        }
    };

    const toggleAll = (checked: boolean) => {
        if (checked) {
            const all = PERMISSION_RESOURCES.flatMap(r => r.actions.map(a => `${r.resource}:${a}`));
            form.setValue("permissions", all);
        } else {
            form.setValue("permissions", []);
        }
    };

    const isAllSelected = PERMISSION_RESOURCES.every(r =>
        r.actions.every(a => selectedPermissions.includes(`${r.resource}:${a}`))
    );

    return (
        <div className="space-y-6 pt-2">
            <div className="flex items-center justify-between pb-2 border-b">
                <div className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                    Permissions Configuration
                </div>
                <div className="flex items-center gap-2">
                    <Label htmlFor="select-all" className="text-xs font-medium cursor-pointer">
                        Select All
                    </Label>
                    <Checkbox id="select-all" checked={isAllSelected} onCheckedChange={toggleAll} />
                </div>
            </div>

            <div className="grid grid-cols-12 items-center gap-4 px-2 pb-2">
                <div className="col-span-4" />
                <div className="col-span-6 flex gap-4">
                    {PERMISSION_ACTIONS.map(action => (
                        <div key={action} className="flex flex-col items-center w-[18px]">
                            <span className="text-[10px] uppercase font-bold tracking-tighter text-muted-foreground">
                                {action.charAt(0)}
                            </span>
                            <span className="text-[9px] text-muted-foreground/50 capitalize">{action}</span>
                        </div>
                    ))}
                </div>
                <div className="col-span-2" />
            </div>

            <div className="max-h-[300px] overflow-y-auto space-y-4 pr-2 scrollbar-thin scrollbar-thumb-muted">
                {PERMISSION_RESOURCES.map((res) => {
                    const isResAllSelected = res.actions.every(a =>
                        selectedPermissions.includes(`${res.resource}:${a}`)
                    );

                    return (
                        <div
                            key={res.resource}
                            className="grid grid-cols-12 items-center gap-4 py-2 border-b border-muted/30 last:border-0 hover:bg-accent/5 px-2 rounded-sm transition-colors"
                        >
                            <div className="col-span-4">
                                <div className="text-sm font-medium capitalize">
                                    {res.resource.replace('_', ' ')}
                                </div>
                            </div>

                            <div className="col-span-6 flex gap-4">
                                {PERMISSION_ACTIONS.map(action => {
                                    const available = (res.actions as readonly PermissionAction[]).includes(action);
                                    const perm = `${res.resource}:${action}`;
                                    return (
                                        <div key={action} className="flex flex-col items-center gap-1">
                                            <Checkbox
                                                checked={available && selectedPermissions.includes(perm)}
                                                onCheckedChange={() => available && togglePermission(perm)}
                                                disabled={!available}
                                                className={!available ? "opacity-20 bg-muted" : ""}
                                            />
                                        </div>
                                    );
                                })}
                            </div>

                            <div className="col-span-2 flex justify-end items-center gap-2 border-l pl-4 border-muted/30">
                                <span className="text-[10px] uppercase font-bold text-muted-foreground">All</span>
                                <Checkbox
                                    checked={isResAllSelected}
                                    onCheckedChange={(checked) => toggleResource(res.resource, res.actions, !!checked)}
                                />
                            </div>
                        </div>
                    );
                })}
            </div>

            <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    Selected Access Scope
                </Label>
                <div className="p-3 rounded-md bg-muted/30 min-h-[60px] flex flex-wrap gap-2 items-start border">
                    {selectedPermissions.length > 0 ? (
                        selectedPermissions.map(p => (
                            <Badge
                                key={p}
                                variant="secondary"
                                className="text-[10px] font-mono border-muted-foreground/20"
                            >
                                {p}
                            </Badge>
                        ))
                    ) : (
                        <div className="text-xs text-amber-500 font-medium italic">
                            No permissions selected — key will have full access
                        </div>
                    )}
                </div>
            </div>

            <div className="flex gap-3 pt-4">
                <Button type="button" variant="outline" onClick={onBack} className="flex-1">
                    Back
                </Button>
                <Button type="submit" disabled={isSubmitting} className="flex-[2]">
                    {isSubmitting ? "Creating..." : "Create API Key"}
                </Button>
            </div>
        </div>
    );
}
