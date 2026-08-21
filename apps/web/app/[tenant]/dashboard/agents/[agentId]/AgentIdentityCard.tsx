"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { ImageUpload } from "@/components/platform/ImageUpload";
import type { AgentDetail } from "@/components/platform/agents/types";
import type { PersonaSummary } from "@/components/platform/personas/types";
import { AvatarBuilderModal } from "@/components/platform/agents/avatar-builder/AvatarBuilderModal";
import type { AvatarParams } from "@/components/platform/agents/avatar-builder/avatarParams";
import { BrandingLockedOverlay } from "./BrandingLockedOverlay";

const NO_PERSONA_VALUE = "__none__";

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
    const [form, setForm] = React.useState<{ name: string; avatarUrl: string; avatarFileId: string | null; avatarParams: AvatarParams | null; personaId: string | null }>({ name: "", avatarUrl: "", avatarFileId: null, avatarParams: null, personaId: null });
    const [isDirty, setIsDirty] = React.useState(false);
    const [isBuilderOpen, setIsBuilderOpen] = React.useState(false);

    const { data: personasData } = useQuery<{ personas: PersonaSummary[] }>({
        queryKey: ["personas"],
        queryFn: () => api.get<{ personas: PersonaSummary[] }>("/api/v1/agents/personas"),
    });

    React.useEffect(() => {
        if (agent) {
            setForm({ name: agent.name ?? "", avatarUrl: agent.avatarUrl ?? "", avatarFileId: agent.avatarFileId ?? null, avatarParams: agent.avatarParams ?? null, personaId: agent.persona?.id ?? null });
            setIsDirty(false);
        }
    }, [agent]);

    const updateMutation = useMutation({
        mutationFn: (values: { name: string; avatarFileId: string | null; avatarParams: AvatarParams | null; personaId: string | null }) =>
            api.patch(`/api/v1/agents/${agentId}`, {
                name: values.name || undefined,
                avatarFileId: values.avatarFileId,
                avatarParams: values.avatarParams,
                personaId: values.personaId,
            }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["agents", agentId] });
            setIsDirty(false);
            toast.success("Agent updated");
        },
        onError: (err) => {
            const msg = err instanceof ApiError
                ? (err.data?.message || err.message)
                : err instanceof Error ? err.message : "Failed to update agent";
            toast.error(msg);
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
                                        setForm(prev => ({ ...prev, avatarUrl: url, avatarParams: null }));
                                        setIsDirty(true);
                                    }}
                                    onFileIdChange={(fileId) => {
                                        setForm(prev => ({ ...prev, avatarFileId: fileId }));
                                    }}
                                    disabled={!isOwner}
                                />
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={!isOwner}
                                    onClick={() => setIsBuilderOpen(true)}
                                >
                                    Build Avatar
                                </Button>
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

                            <div className="space-y-1.5">
                                <Label className="text-xs text-muted-foreground uppercase tracking-wider">Persona</Label>
                                <Select
                                    value={form.personaId ?? NO_PERSONA_VALUE}
                                    onValueChange={(value) => {
                                        setForm((f) => ({ ...f, personaId: value === NO_PERSONA_VALUE ? null : value }));
                                        setIsDirty(true);
                                    }}
                                    disabled={!isOwner}
                                >
                                    <SelectTrigger className="w-full">
                                        <SelectValue placeholder="No persona" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={NO_PERSONA_VALUE}>No persona</SelectItem>
                                        {personasData?.personas.map((persona) => (
                                            <SelectItem key={persona.id} value={persona.id}>
                                                {persona.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
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
                        <AvatarBuilderModal
                            open={isBuilderOpen}
                            onOpenChange={setIsBuilderOpen}
                            initialParams={form.avatarParams}
                            agentName={form.name || agent?.name || "agent"}
                            onSave={({ url, fileId, params }) => {
                                setForm(prev => ({ ...prev, avatarUrl: url, avatarFileId: fileId, avatarParams: params }));
                                setIsDirty(true);
                            }}
                        />
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
