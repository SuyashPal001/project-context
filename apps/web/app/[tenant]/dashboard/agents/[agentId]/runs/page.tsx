"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, AlertCircle } from "lucide-react";
import { api } from "@/lib/api";
import { PermissionGate } from "@/components/platform/PermissionGate";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import type { AgentDetail, AgentRunsResponse } from "@/components/platform/agents/types";

import { RunRow } from "./RunRow";
import { RunsPagination } from "./RunsPagination";

const PAGE_SIZE = 20;

export default function AgentRunsPage() {
    const params = useParams();
    const agentId = params.agentId as string;
    const tenantSlug = params.tenant as string;

    const [page, setPage] = React.useState(1);
    const [expandedRows, setExpandedRows] = React.useState<Set<string>>(new Set());

    const { data: agent, isLoading: isLoadingAgent } = useQuery({
        queryKey: ["agents", agentId],
        queryFn: () => api.get<AgentDetail>(`/api/v1/agents/${agentId}`),
    });

    const { data, isLoading: isLoadingRuns, isError, error } = useQuery<AgentRunsResponse>({
        queryKey: ["agent-runs", agentId, page, PAGE_SIZE],
        queryFn: () =>
            api.get<AgentRunsResponse>(
                `/api/v1/agent-runs?agentId=${agentId}&page=${page}&pageSize=${PAGE_SIZE}`
            ),
    });

    const toggleRow = (runId: string) => {
        setExpandedRows((prev) => {
            const next = new Set(prev);
            if (next.has(runId)) next.delete(runId);
            else next.add(runId);
            return next;
        });
    };

    const runs = data?.runs ?? [];
    const totalPages = data?.totalPages ?? 1;

    return (
        <PermissionGate resource="agents" action="read">
            <div className="space-y-8">
                <div className="space-y-4">
                    <Link
                        href={`/${tenantSlug}/dashboard/agents/${agentId}`}
                        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors w-fit"
                    >
                        <ArrowLeft className="h-4 w-4" />
                        Back to {isLoadingAgent ? "Agent" : (agent?.name ?? "Agent")}
                    </Link>

                    <div>
                        <h1 className="text-3xl font-bold tracking-tight">
                            Runs — {isLoadingAgent ? "..." : (agent?.name ?? "Agent")}
                        </h1>
                        <p className="text-muted-foreground mt-1">
                            Execution history and actions performed by this agent.
                        </p>
                    </div>
                </div>

                {isError && (
                    <Alert variant="destructive">
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle>Error Loading Runs</AlertTitle>
                        <AlertDescription>
                            {error instanceof Error
                                ? error.message
                                : "Failed to load agent runs. Please try again."}
                        </AlertDescription>
                    </Alert>
                )}

                {!isError && (
                    <div className="space-y-4">
                        <div className="rounded-md border border-border overflow-hidden">
                            <Table>
                                <TableHeader>
                                    <TableRow className="hover:bg-transparent">
                                        <TableHead className="w-[110px]">Run ID</TableHead>
                                        <TableHead>Trigger</TableHead>
                                        <TableHead className="w-[160px]">Status</TableHead>
                                        <TableHead>Started At</TableHead>
                                        <TableHead>Completed At</TableHead>
                                        <TableHead className="w-[110px]">Duration</TableHead>
                                        <TableHead className="w-[40px]" />
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {isLoadingRuns ? (
                                        Array.from({ length: 6 }).map((_, i) => (
                                            <TableRow key={i}>
                                                {Array.from({ length: 7 }).map((_, j) => (
                                                    <TableCell key={j}>
                                                        <Skeleton className="h-4 w-full" />
                                                    </TableCell>
                                                ))}
                                            </TableRow>
                                        ))
                                    ) : runs.length === 0 ? (
                                        <TableRow>
                                            <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                                                No runs found for this agent.
                                            </TableCell>
                                        </TableRow>
                                    ) : (
                                        runs.map((run) => (
                                            <RunRow
                                                key={run.id}
                                                run={run}
                                                isExpanded={expandedRows.has(run.id)}
                                                onToggle={() => toggleRow(run.id)}
                                            />
                                        ))
                                    )}
                                </TableBody>
                            </Table>
                        </div>

                        <RunsPagination
                            page={page}
                            totalPages={totalPages}
                            isLoading={isLoadingRuns}
                            onPrev={() => setPage((p) => Math.max(1, p - 1))}
                            onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
                        />
                    </div>
                )}
            </div>
        </PermissionGate>
    );
}
