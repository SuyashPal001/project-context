"use client";

import { useState } from "react";
import { Brain, Globe, FileSearch, CalendarClock, Network } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { AttachSkillPicker } from "@/components/platform/skills/AttachSkillPicker";
import { api } from "@/lib/api";
import { detachSkillFromAgent } from "@/components/platform/skills/actions";
import type { AgentDetail } from "@/components/platform/agents/types";
import { agentDescription, isSupervisor } from "@/components/platform/agents/agentDescription";

interface AgentSkillSectionProps {
    agentId: string;
    isOwner: boolean;
    brandingEnabled: boolean;
    tenantSlug: string;
    agent: AgentDetail | undefined;
    isLoading: boolean;
}

const BASE_CAPABILITIES = [
    { icon: Brain, label: "Conversation memory", description: "Remembers context across turns in the same session" },
    { icon: FileSearch, label: "Knowledge base", description: "Searches your uploaded documents via RAG" },
    { icon: Globe, label: "Web search", description: "Looks up live information from the internet" },
    { icon: CalendarClock, label: "Scheduled runs", description: "Can be triggered automatically on a cron schedule" },
];

const SUPERVISOR_CAPABILITY = {
    icon: Network,
    label: "Delegates to specialist agents",
    description: "Spins up PRD, Roadmap, and Task agents to handle each phase — you only talk to one agent",
};

interface CapabilityItem {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    description: string;
}

export function AgentSkillSection({ agent, agentId, isLoading }: AgentSkillSectionProps) {
    const [attachOpen, setAttachOpen] = useState(false);

    // The agent's standing skills — always available to it, loaded when
    // relevant. The composer never shows these; this page is where they live.
    const queryClient = useQueryClient();
    const { data: attachedData } = useQuery({
        queryKey: ["agent-skills", agentId],
        queryFn: () => api.get<{ data: Array<{ id: string; name: string }> }>(`/api/v1/agents/${agentId}/skills`),
        enabled: !!agentId,
    });
    const attached = attachedData?.data ?? [];
    const detach = useMutation({
        mutationFn: (agentSkillId: string) => detachSkillFromAgent(agentId, agentSkillId),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agent-skills", agentId] }),
        onError: () => toast.error("Could not detach that skill"),
    });

    const name = agent?.name ?? "";
    const description = agentDescription(name, agent?.description);

    const capabilities: CapabilityItem[] = isSupervisor(name)
        ? [SUPERVISOR_CAPABILITY, ...BASE_CAPABILITIES]
        : BASE_CAPABILITIES;

    return (
        <>
            <Card>
                <CardContent className="pt-6 space-y-3">
                    <div>
                        <h3 className="text-sm font-semibold">About this agent</h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            What this agent does and when to use it.
                        </p>
                    </div>
                    {isLoading ? (
                        <div className="space-y-2">
                            <Skeleton className="h-4 w-full" />
                            <Skeleton className="h-4 w-4/5" />
                            <Skeleton className="h-4 w-3/5" />
                        </div>
                    ) : (
                        <p className="text-sm text-muted-foreground leading-relaxed">
                            {description}
                        </p>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardContent className="pt-6 space-y-3">
                    <div>
                        <h3 className="text-sm font-semibold">Capabilities</h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            What this agent can do during a conversation.
                        </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {capabilities.map(({ icon: Icon, label, description: cap }) => (
                            <div
                                key={label}
                                className="flex items-start gap-3 rounded-lg border border-border bg-muted/10 px-4 py-3"
                            >
                                <Icon className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                                <div className="space-y-0.5">
                                    <p className="text-sm font-medium">{label}</p>
                                    <p className="text-xs text-muted-foreground">{cap}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardContent className="pt-6 space-y-3">
                    <div className="flex items-center justify-between">
                        <div>
                            <h3 className="text-sm font-semibold">Skills library</h3>
                            <p className="text-xs text-muted-foreground mt-0.5">
                                Skills this agent can use in every conversation. It loads one when it's relevant.
                            </p>
                        </div>
                        <Button size="sm" variant="outline" onClick={() => setAttachOpen(true)}>
                            Attach from library
                        </Button>
                    </div>
                    {attached.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No skills attached yet.</p>
                    ) : (
                        <ul className="space-y-2">
                            {attached.map((skill) => (
                                <li key={skill.id} className="flex items-center justify-between rounded-lg border border-border bg-muted/10 px-4 py-2">
                                    <span className="text-sm font-medium">{skill.name}</span>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        aria-label={`Detach ${skill.name}`}
                                        disabled={detach.isPending}
                                        onClick={() => detach.mutate(skill.id)}
                                    >
                                        Detach
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </CardContent>
            </Card>

            <AttachSkillPicker
                agentId={agentId}
                open={attachOpen}
                onOpenChange={setAttachOpen}
                onAttached={() => queryClient.invalidateQueries({ queryKey: ["agent-skills", agentId] })}
            />
        </>
    );
}
