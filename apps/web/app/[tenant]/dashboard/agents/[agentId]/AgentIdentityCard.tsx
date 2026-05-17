"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ImageUpload } from "@/components/platform/ImageUpload";
import type { AgentDetail } from "@/components/platform/agents/types";
import { BrandingLockedOverlay } from "./BrandingLockedOverlay";

interface AgentIdentityCardProps {
    agent: AgentDetail | undefined;
    agentId: string;
    isLoading: boolean;
    isOwner: boolean;
    brandingEnabled: boolean;
    tenantSlug: string;
}

export function AgentIdentityCard({
    agent,
    agentId,
    isLoading,
    isOwner,
    brandingEnabled,
    tenantSlug,
}: AgentIdentityCardProps) {
    const queryClient = useQueryClient();
    const [form, setForm] = React.useState({ name: "", avatarUrl: "" });
    const [isDirty, setIsDirty] = React.useState(false);

    React.useEffect(() => {
        if (agent) {
            setForm({ name: agent.name ?? "", avatarUrl: agent.avatarUrl ?? "" });
            setIsDirty(false);
        }
    }, [agent]);

    const updateMutation = useMutation({
        mutationFn: (values: { name: string; avatarUrl: string }) =>
            api.patch(`/api/v1/agents/${agentId}`, {
                name: values.name || undefined,
                avatarUrl: values.avatarUrl || null,
            }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["agents", agentId] });
            setIsDirty(false);
            toast.success("Agent updated");
        },
        onError: (error: any) => {
            toast.error(error.data?.message || error.message || "Failed to update agent");
        },
    });

    const initials = (form.name || agent?.name || "?")
        .split(" ")
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();

    return (
        <Card>
            <CardContent className="pt-6">
                <h3 className="text-sm font-semibold mb-4">Agent Identity</h3>
                {isLoading ? (
                    <div className="space-y-4">
                        <Skeleton className="h-16 w-16 rounded-full" />
                        <Skeleton className="h-9 w-full" />
                        <Skeleton className="h-20 w-full" />
                    </div>
                ) : (
                    <div className="relative">
                        <div className={cn("space-y-6", !brandingEnabled && "opacity-40 pointer-events-none select-none")}>
                            <div className="space-y-1.5">
                                <Label className="text-xs text-muted-foreground uppercase tracking-wider">Agent Avatar</Label>
                                <ImageUpload
                                    value={form.avatarUrl}
                                    fallbackText={initials}
                                    onChange={(url) => {
                                        setForm(prev => ({ ...prev, avatarUrl: url }));
                                        setIsDirty(true);
                                    }}
                                    disabled={!isOwner}
                                />
                            </div>

                            <div className="space-y-1.5">
                                <Label className="text-xs text-muted-foreground uppercase tracking-wider">Name</Label>
                                <Input
                                    value={form.name}
                                    onChange={(e) => {
                                        setForm((f) => ({ ...f, name: e.target.value }));
                                        setIsDirty(true);
                                    }}
                                    disabled={!isOwner}
                                    placeholder="Agent name"
                                />
                            </div>

                            {isOwner && isDirty && (
                                <div className="flex justify-end">
                                    <Button
                                        size="sm"
                                        onClick={() => updateMutation.mutate(form)}
                                        disabled={updateMutation.isPending || !form.name.trim()}
                                    >
                                        {updateMutation.isPending && (
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        )}
                                        Save
                                    </Button>
                                </div>
                            )}
                        </div>

                        {!brandingEnabled && <BrandingLockedOverlay tenantSlug={tenantSlug} />}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
