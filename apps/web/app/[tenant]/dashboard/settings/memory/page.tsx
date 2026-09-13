"use client";

import { useQuery } from "@tanstack/react-query";
import { Brain, AlertCircle } from "lucide-react";

import { api } from "@/lib/api";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { PermissionGate } from "@/components/platform/PermissionGate";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

type TenantMemoryInsights = {
    topics: string[];
    areas: string[];
    projects: string[];
    threadCount: number;
    updatedAt: string | null;
};

// Read-only view of what pm/director/producer's shared memory (Observational
// Memory, scope: 'thread' for now — see project_om_rollout_plan memory note)
// has extracted about this tenant across conversations with those agents.
// Olmo and architect don't feed this: Olmo has no persistent memory, and
// architect uses its own separate memory instance.
function MemorySection({ title, items }: { title: string; items: string[] }) {
    return (
        <div className="space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
            {items.length === 0 ? (
                <p className="text-sm text-muted-foreground/70">Nothing extracted yet.</p>
            ) : (
                <div className="flex flex-wrap gap-2">
                    {items.map((item) => (
                        <Badge key={item} variant="secondary">
                            {item}
                        </Badge>
                    ))}
                </div>
            )}
        </div>
    );
}

export default function TenantMemoryPage() {
    const { tenantId } = useTenant();

    const { data, isLoading, error } = useQuery({
        queryKey: ["tenant-memory", tenantId],
        queryFn: () => api.get<{ data: TenantMemoryInsights }>("/api/v1/tenant-memory"),
    });

    const insights = data?.data;

    return (
        <PermissionGate resource="agents" action="read">
            <div className="space-y-6">
                <div>
                    <h1 className="text-2xl font-semibold tracking-tight">Memory</h1>
                    <p className="text-sm text-muted-foreground">
                        What your PM, Director, and Producer agents have picked up across
                        conversations with your team. Shared across those three agents —
                        not per-agent.
                    </p>
                </div>

                {error ? (
                    <Alert variant="destructive">
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle>Error</AlertTitle>
                        <AlertDescription>
                            Failed to load memory insights. Try again shortly.
                        </AlertDescription>
                    </Alert>
                ) : (
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-base">
                                <Brain className="h-4 w-4" />
                                Extracted memory
                            </CardTitle>
                            <CardDescription>
                                {isLoading
                                    ? "Loading…"
                                    : `From ${insights?.threadCount ?? 0} conversation${insights?.threadCount === 1 ? "" : "s"}${
                                          insights?.updatedAt
                                              ? ` · last updated ${new Date(insights.updatedAt).toLocaleString()}`
                                              : ""
                                      }`}
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            {isLoading ? (
                                <div className="space-y-4">
                                    <Skeleton className="h-16 w-full" />
                                    <Skeleton className="h-16 w-full" />
                                    <Skeleton className="h-16 w-full" />
                                </div>
                            ) : (
                                <>
                                    <MemorySection title="Topics" items={insights?.topics ?? []} />
                                    <MemorySection title="Areas" items={insights?.areas ?? []} />
                                    <MemorySection title="Projects" items={insights?.projects ?? []} />
                                </>
                            )}
                        </CardContent>
                    </Card>
                )}
            </div>
        </PermissionGate>
    );
}
