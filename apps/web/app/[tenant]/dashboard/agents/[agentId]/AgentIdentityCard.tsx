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
import { OlmoMark } from "@/components/platform/OlmoMark";

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

    // Fired directly from the avatar builder's "Use This Avatar" — that action reads
    // as "save this now", not "stage it until you separately click Save". Previously
    // it only updated local form state, so navigating away or reloading before the
    // unrelated Save button was clicked silently discarded the new avatar.
    const saveAvatarMutation = useMutation({
        mutationFn: (values: { avatarFileId: string; avatarParams: AvatarParams }) =>
            api.patch(`/api/v1/agents/${agentId}`, {
                avatarFileId: values.avatarFileId,
                avatarParams: values.avatarParams,
            }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["agents", agentId] });
            toast.success("Avatar saved");
        },
        onError: (err) => {
            const msg = err instanceof ApiError
                ? (err.data?.message || err.message)
                : err instanceof Error ? err.message : "Failed to save avatar";
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
                        <div className={cn("space-y-6", !brandingEnabled && agent?.origin !== "built_in" && "opacity-40 pointer-events-none select-none")}>
                            <div className="space-y-1.5">
                                <Label className="text-xs text-muted-foreground uppercase tracking-wider">Agent Avatar</Label>
                                {agent?.origin === "built_in" ? (
                                    <div className="space-y-2">
                                        <div className="h-20 w-20 shrink-0 rounded-full overflow-hidden bg-secondary border-2 border-border flex items-center justify-center">
                                            <OlmoMark height={40} centered />
                                        </div>
                                        <p className="text-xs text-muted-foreground">The built-in agent uses the platform's brand mark and can't be given a custom avatar.</p>
                                    </div>
                                ) : (
                                    <>
                                        <ImageUpload
                                            value={form.avatarUrl}
                                            fallbackText={initials}
                                            onChange={(url) => {
                                                // Remove passes "" here — also clear avatarFileId, otherwise
                                                // Save persists the old file id unchanged (the preview clears
                                                // locally but the removal never reaches the server).
                                                setForm(prev => ({ ...prev, avatarUrl: url, avatarParams: null, avatarFileId: url ? prev.avatarFileId : null }));
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
                                    </>
                                )}
                            </div>

                            <div className="space-y-1.5">
                                <Label className="text-xs text-muted-foreground uppercase tracking-wider">Name</Label>
                                {agent?.origin === "built_in" ? (
                                    <p className="text-sm">{form.name}</p>
                                ) : (
                                    <Input
                                        value={form.name}
                                        onChange={(e) => {
                                            setForm((f) => ({ ...f, name: e.target.value }));
                                            setIsDirty(true);
                                        }}
                                        disabled={!isOwner}
                                        placeholder="Agent name"
                                    />
                                )}
                            </div>

                            <div className="space-y-1.5">
                                <Label className="text-xs text-muted-foreground uppercase tracking-wider">Persona</Label>
                                {agent?.origin === "built_in" ? (
                                    <p className="text-sm text-muted-foreground">The built-in agent doesn't take a persona.</p>
                                ) : (
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
                                )}
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

                        {!brandingEnabled && agent?.origin !== "built_in" && <BrandingLockedOverlay tenantSlug={tenantSlug} />}
                        <AvatarBuilderModal
                            open={isBuilderOpen}
                            onOpenChange={setIsBuilderOpen}
                            initialParams={form.avatarParams}
                            agentName={form.name || agent?.name || "agent"}
                            onSave={async ({ url, fileId, params }) => {
                                setForm(prev => ({ ...prev, avatarUrl: url, avatarFileId: fileId, avatarParams: params }));
                                await saveAvatarMutation.mutateAsync({ avatarFileId: fileId, avatarParams: params });
                            }}
                        />
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
