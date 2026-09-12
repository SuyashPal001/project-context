"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { AgentDetail } from "@/components/platform/agents/types";

interface AgentInfoCardProps {
    agent: AgentDetail | undefined;
    isLoading: boolean;
}

// No "Mind"/model row here on purpose: the model is changeable live from
// ChatInput.tsx's "Mind" picker mid-conversation, so a static snapshot on
// this page would just go stale the moment someone switches it there.
export function AgentInfoCard({ agent, isLoading }: AgentInfoCardProps) {
    const formattedDate = agent
        ? new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(new Date(agent.createdAt))
        : "";

    return (
        <Card>
            <CardContent className="pt-6">
                <h3 className="text-sm font-semibold mb-3">Info</h3>
                {isLoading ? (
                    <div className="space-y-2">
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="h-4 w-44" />
                    </div>
                ) : (
                    <dl className="space-y-2 text-sm">
                        <div className="flex gap-2">
                            <dt className="text-muted-foreground w-24 shrink-0">Created</dt>
                            <dd className="text-foreground">{formattedDate}</dd>
                        </div>
                        <div className="flex gap-2">
                            <dt className="text-muted-foreground w-24 shrink-0">Created by</dt>
                            <dd className="text-foreground">{agent?.createdByName ?? "Unknown"}</dd>
                        </div>
                    </dl>
                )}
            </CardContent>
        </Card>
    );
}
