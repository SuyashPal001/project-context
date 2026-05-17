"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { BrandingLockedOverlay } from "./BrandingLockedOverlay";

interface AgentSkill {
    id: string;
    name: string;
    systemPrompt: string;
    tools: string[];
    config: Record<string, unknown> | null;
    version: number;
    status: "active" | "archived";
}

interface SkillsResponse {
    data: AgentSkill[];
}

interface AgentSkillSectionProps {
    agentId: string;
    isOwner: boolean;
    brandingEnabled: boolean;
    tenantSlug: string;
}

export function AgentSkillSection({ agentId, isOwner, brandingEnabled, tenantSlug }: AgentSkillSectionProps) {
    const queryClient = useQueryClient();

    const { data: skillsData, isLoading } = useQuery<SkillsResponse>({
        queryKey: ["agent-skills", agentId],
        queryFn: () => api.get<SkillsResponse>(`/api/v1/agents/${agentId}/skills`),
        enabled: !!agentId,
    });

    const existingSkill = skillsData?.data?.[0] ?? null;

    const [promptDraft, setPromptDraft] = React.useState("");
    const [isPromptDirty, setIsPromptDirty] = React.useState(false);
    const [webSearchEnabled, setWebSearchEnabled] = React.useState(false);

    React.useEffect(() => {
        if (existingSkill) {
            setPromptDraft(existingSkill.systemPrompt ?? "");
            setWebSearchEnabled(existingSkill.tools?.includes("web_search") ?? false);
            setIsPromptDirty(false);
        }
    }, [existingSkill]);

    const saveSkillMutation = useMutation({
        mutationFn: ({ tools, systemPrompt }: { tools: string[]; systemPrompt: string }) => {
            const body = {
                name: existingSkill?.name ?? "default",
                systemPrompt,
                tools,
                config: existingSkill?.config ?? {},
            };
            if (existingSkill) {
                return api.put(`/api/v1/agents/${agentId}/skills/${existingSkill.id}`, body);
            }
            return api.post(`/api/v1/agents/${agentId}/skills`, body);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["agent-skills", agentId] });
            setIsPromptDirty(false);
            toast.success("Prompt saved");
        },
        onError: (error: any) => {
            toast.error(error.data?.message || error.message || "Failed to save prompt");
        },
    });

    const handleWebSearchToggle = (checked: boolean) => {
        setWebSearchEnabled(checked);
        const currentTools = existingSkill?.tools ?? ["retrieve_documents"];
        let newTools = [...currentTools];
        if (checked) {
            if (!newTools.includes("web_search")) newTools.push("web_search");
        } else {
            newTools = newTools.filter((t) => t !== "web_search");
        }
        saveSkillMutation.mutate({
            tools: newTools,
            systemPrompt: promptDraft || existingSkill?.systemPrompt || "",
        });
    };

    const handleSavePrompt = () => {
        const currentTools = existingSkill?.tools ?? ["retrieve_documents"];
        const newTools = [...currentTools];
        if (webSearchEnabled && !newTools.includes("web_search")) newTools.push("web_search");
        saveSkillMutation.mutate({ tools: newTools, systemPrompt: promptDraft });
    };

    return (
        <>
            <Card>
                <CardContent className="pt-6">
                    <div className="mb-4">
                        <h3 className="text-sm font-semibold">General Prompt</h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            System instructions that shape this agent&apos;s behaviour on every conversation.
                        </p>
                    </div>
                    {isLoading ? (
                        <Skeleton className="h-32 w-full" />
                    ) : (
                        <div className="relative">
                            <div className={cn("space-y-3", !brandingEnabled && "opacity-40 pointer-events-none select-none")}>
                                <Textarea
                                    value={promptDraft}
                                    onChange={(e) => {
                                        setPromptDraft(e.target.value);
                                        setIsPromptDirty(true);
                                    }}
                                    placeholder="You are a helpful assistant..."
                                    rows={6}
                                    disabled={!isOwner}
                                    className="resize-none font-mono text-sm"
                                />
                                {isOwner && isPromptDirty && (
                                    <div className="flex justify-end">
                                        <Button
                                            size="sm"
                                            onClick={handleSavePrompt}
                                            disabled={saveSkillMutation.isPending}
                                        >
                                            {saveSkillMutation.isPending && (
                                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                            )}
                                            Save Prompt
                                        </Button>
                                    </div>
                                )}
                            </div>

                            {!brandingEnabled && <BrandingLockedOverlay tenantSlug={tenantSlug} />}
                        </div>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardContent className="pt-6">
                    <div className="mb-4">
                        <h3 className="text-sm font-semibold">Tools</h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            Capabilities available to this agent during conversations.
                        </p>
                    </div>
                    <div className="space-y-3">
                        <div className="flex items-center justify-between rounded-lg border border-border bg-muted/10 px-4 py-3">
                            <div className="space-y-0.5">
                                <p className="text-sm font-medium">Knowledge base</p>
                                <p className="text-xs text-muted-foreground">Search tenant documents via RAG</p>
                            </div>
                            <div className="flex items-center gap-2 text-muted-foreground">
                                <Lock className="h-3.5 w-3.5" />
                                <span className="text-xs">Always on</span>
                            </div>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border border-border bg-muted/10 px-4 py-3">
                            <div className="space-y-0.5">
                                <p className="text-sm font-medium">Web search</p>
                                <p className="text-xs text-muted-foreground">Search the web for current information</p>
                            </div>
                            <Switch
                                checked={webSearchEnabled}
                                onCheckedChange={handleWebSearchToggle}
                                disabled={!isOwner || saveSkillMutation.isPending || isLoading}
                            />
                        </div>
                    </div>
                </CardContent>
            </Card>
        </>
    );
}
