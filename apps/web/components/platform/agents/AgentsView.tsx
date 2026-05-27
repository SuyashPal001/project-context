"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { CreateAgentDialog } from "./CreateAgentDialog";
import { AgentCard } from "./AgentCard";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle, Plus, BrainCircuit } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentsResponse } from "./types";

interface PlatformAgent {
    id: string;
    name: string;
    description: string;
}

// Agents defined in the Mastra code registry (relay) — not DB-managed.
// Visible in Mastra Studio for testing; shown here as read-only info cards.
function PlatformAgentCard({ agent }: { agent: PlatformAgent }) {
    return (
        <div className="rounded-xl border border-border bg-card p-5 space-y-3">
            <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                    <BrainCircuit className="h-4 w-4 text-primary" />
                </div>
                <div>
                    <p className="font-semibold text-sm text-foreground">{agent.name}</p>
                    <p className="text-xs text-muted-foreground">Platform Agent</p>
                </div>
            </div>
            <p className="text-xs text-muted-foreground line-clamp-3">
                {agent.description || "Mastra-registered AI agent."}
            </p>
        </div>
    );
}

export function AgentsView() {
    const { role } = useTenant();
    const isPlatformAdmin = role === 'platform_admin';

    const { data, isLoading, isError, error } = useQuery<AgentsResponse>({
        queryKey: ["agents"],
        queryFn: () => api.get<AgentsResponse>("/api/v1/agents"),
    });

    const { data: platformData } = useQuery<{ agents: PlatformAgent[] }>({
        queryKey: ["platform-agents"],
        queryFn: async () => {
            const res = await fetch("/api/platform-agents");
            return res.json();
        },
        staleTime: 60_000,
    });

    const platformAgents = platformData?.agents ?? [];

    if (isError) {
        return (
            <div className="space-y-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-foreground">Agents</h1>
                        <p className="text-muted-foreground mt-2">Configure and manage your AI agents</p>
                    </div>
                </div>
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Error</AlertTitle>
                    <AlertDescription>
                        {error instanceof Error ? error.message : "Failed to load agents. Please try again later."}
                    </AlertDescription>
                </Alert>
            </div>
        );
    }

    const dbAgents = (data?.data ?? []).filter(
        (agent) => !agent.isInternal && (isPlatformAdmin || agent.status === 'active')
    );

    return (
        <div className="space-y-8">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">Agents</h1>
                    <p className="text-muted-foreground mt-2">Configure and manage your AI agents</p>
                </div>
                {isPlatformAdmin && (
                    <CreateAgentDialog>
                        <Button>
                            <Plus className="mr-2 h-4 w-4" />
                            New Agent
                        </Button>
                    </CreateAgentDialog>
                )}
            </div>

            {/* DB-managed agents */}
            {isLoading ? (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {Array.from({ length: 3 }).map((_, i) => (
                        <Skeleton key={i} className="h-[200px] w-full rounded-xl" />
                    ))}
                </div>
            ) : dbAgents.length > 0 ? (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {dbAgents.map((agent) => (
                        <AgentCard key={agent.id} agent={agent} />
                    ))}
                </div>
            ) : null}

            {/* Platform (Mastra code-registered) agents */}
            {platformAgents.length > 0 && (
                <div className="space-y-3">
                    <div>
                        <h2 className="text-lg font-semibold text-foreground">Platform Agents</h2>
                        <p className="text-sm text-muted-foreground">Mastra AI agents — testable in Studio</p>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                        {platformAgents.map((agent) => (
                            <PlatformAgentCard key={agent.id} agent={agent} />
                        ))}
                    </div>
                </div>
            )}

            {/* Empty state — only if both lists are empty */}
            {!isLoading && dbAgents.length === 0 && platformAgents.length === 0 && (
                <div className="flex h-[350px] shrink-0 items-center justify-center rounded-xl border border-dashed border-border bg-muted/20">
                    <div className="mx-auto flex max-w-[420px] flex-col items-center justify-center text-center">
                        <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center mb-4">
                            <AlertCircle className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <h3 className="text-lg font-semibold text-foreground">No agents found</h3>
                        <p className="mb-6 mt-2 text-sm text-muted-foreground">
                            {isPlatformAdmin ? "No agents yet. Create your first agent." : "No active agents available at the moment."}
                        </p>
                        {isPlatformAdmin && (
                            <CreateAgentDialog>
                                <Button>
                                    <Plus className="mr-2 h-4 w-4" />
                                    Create Agent
                                </Button>
                            </CreateAgentDialog>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
