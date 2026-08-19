"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ArrowLeft, AlertCircle, Loader2, MessageSquare, CalendarClock, History } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { PermissionGate } from "@/components/platform/PermissionGate";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { AgentDetail } from "@/components/platform/agents/types";

import { AgentIdentityCard } from "./AgentIdentityCard";
import { AgentInfoCard } from "./AgentInfoCard";
import { AgentSkillSection } from "./AgentSkillSection";
import { AgentCoreFilesSection } from "./AgentCoreFilesSection";

interface LLMProvider {
    id: string;
    provider: string;
    model: string;
    displayName: string;
    isDefault: boolean;
    status: string;
}

interface LLMProvidersResponse {
    providers: LLMProvider[];
}

const typeColors: Record<string, string> = {
    ops: "bg-secondary text-muted-foreground",
    support: "bg-secondary text-muted-foreground",
    billing: "bg-secondary text-muted-foreground",
    custom: "bg-secondary text-muted-foreground",
};

const statusColors: Record<string, string> = {
    active: "bg-emerald-500/10 text-emerald-500",
    paused: "bg-yellow-500/10 text-yellow-500",
    retired: "bg-red-500/10 text-red-500",
};

export default function AgentDetailPage() {
    const params = useParams();
    const router = useRouter();
    const agentId = params.agentId as string;
    const tenantSlug = params.tenant as string;
    const { role, entitlementFeatures } = useTenant();
    const brandingEnabled = entitlementFeatures?.['branding'] === true;
    const isOwner = role === 'owner' || role === 'platform_admin';

    const { data: agent, isLoading: isLoadingAgent, error: agentError } = useQuery({
        queryKey: ["agents", agentId],
        queryFn: () => api.get<AgentDetail>(`/api/v1/agents/${agentId}`),
    });

    const { data: providersData } = useQuery<LLMProvidersResponse>({
        queryKey: ["llm-providers"],
        queryFn: () => api.get<LLMProvidersResponse>("/api/v1/llm-providers"),
    });

    const providers = providersData?.providers || [];

    const startChatMutation = useMutation({
        mutationFn: () =>
            api.post<{ data: { id: string } }>("/api/v1/conversations", { agentId }),
        onSuccess: (res) => {
            router.push(`/${tenantSlug}/dashboard/chat?id=${res.data.id}`);
        },
        onError: () => {
            toast.error("Failed to start conversation");
        },
    });

    if (agentError) {
        return (
            <PermissionGate resource="agents" action="read">
                <div className="space-y-6">
                    <Link
                        href={`/${tenantSlug}/dashboard/agents`}
                        className="flex items-center text-sm text-muted-foreground hover:text-foreground"
                    >
                        <ArrowLeft className="mr-2 h-4 w-4" />
                        Back to Agents
                    </Link>
                    <Alert variant="destructive">
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle>Error</AlertTitle>
                        <AlertDescription>
                            Failed to load agent details. The agent might not exist or you don&apos;t have access.
                        </AlertDescription>
                    </Alert>
                </div>
            </PermissionGate>
        );
    }

    return (
        <PermissionGate resource="agents" action="read">
            <div className="space-y-8">
                <div className="flex items-start justify-between gap-4">
                    <div className="space-y-3">
                        <Link
                            href={`/${tenantSlug}/dashboard/agents`}
                            className="flex items-center text-sm text-muted-foreground hover:text-foreground w-fit"
                        >
                            <ArrowLeft className="mr-2 h-4 w-4" />
                            Back to Agents
                        </Link>
                        {isLoadingAgent ? (
                            <Skeleton className="h-8 w-48" />
                        ) : (
                            <div className="flex items-center gap-3">
                                <h1 className="text-2xl font-bold tracking-tight">{agent?.name}</h1>
                                <Badge variant="secondary" className={typeColors[agent?.type || ""]}>
                                    {agent?.type}
                                </Badge>
                                <Badge variant="outline" className={statusColors[agent?.status || ""]}>
                                    {agent?.status}
                                </Badge>
                            </div>
                        )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <Button variant="outline" size="sm" asChild>
                            <Link href={`/${tenantSlug}/dashboard/agents/${agentId}/runs`}>
                                <History className="mr-2 h-4 w-4" />
                                Runs
                            </Link>
                        </Button>
                        <Button variant="outline" size="sm" asChild>
                            <Link href={`/${tenantSlug}/dashboard/agents/${agentId}/scheduled`}>
                                <CalendarClock className="mr-2 h-4 w-4" />
                                Scheduled
                            </Link>
                        </Button>
                        <Button
                            size="sm"
                            onClick={() => startChatMutation.mutate()}
                            disabled={isLoadingAgent || startChatMutation.isPending}
                        >
                            {startChatMutation.isPending
                                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                : <MessageSquare className="mr-2 h-4 w-4" />}
                            Chat with Agent
                        </Button>
                    </div>
                </div>

                <AgentIdentityCard
                    agent={agent}
                    agentId={agentId}
                    isLoading={isLoadingAgent}
                    isOwner={isOwner}
                    brandingEnabled={brandingEnabled}
                    tenantSlug={tenantSlug}
                />

                <AgentInfoCard
                    agent={agent}
                    providers={providers}
                    isLoading={isLoadingAgent}
                />

                <AgentSkillSection
                    agentId={agentId}
                    isOwner={isOwner}
                    brandingEnabled={brandingEnabled}
                    tenantSlug={tenantSlug}
                    agent={agent}
                    isLoading={isLoadingAgent}
                />

                <AgentCoreFilesSection agentId={agentId} />
            </div>
        </PermissionGate>
    );
}
