"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, MessageCircleQuestion } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { OpsKnowledgeGapsResponse } from "@/components/platform/ops/types";

function fmtTs(iso: string | null | undefined) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short" }).format(d);
}

export default function KnowledgeGapsPage() {
    const { data, isLoading, isError, error } = useQuery<OpsKnowledgeGapsResponse>({
        queryKey: ["ops-knowledge-gaps"],
        queryFn: () => api.get<OpsKnowledgeGapsResponse>("/api/v1/ops/agent-intelligence/knowledge-gaps"),
    });

    const gaps = data?.gaps ?? [];

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight text-foreground">Knowledge Gaps</h1>
                <p className="text-muted-foreground text-sm mt-1">Questions agents couldn't answer — RAG fired but returned no relevant chunks.</p>
            </div>

            {isError && (
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" /><AlertTitle>Error</AlertTitle>
                    <AlertDescription>{error instanceof ApiError ? (error.data?.error ?? error.data?.message ?? `Server error ${error.status}`) : "Failed to load knowledge gaps."}</AlertDescription>
                </Alert>
            )}

            {!isLoading && !isError && gaps.length === 0 && (
                <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground/80 border border-border rounded-xl bg-card">
                    <MessageCircleQuestion className="h-10 w-10 opacity-40" />
                    <p className="text-sm">No knowledge gaps detected. Agents are finding answers.</p>
                </div>
            )}

            {(isLoading || gaps.length > 0) && (
                <div className="border border-border rounded-xl bg-card overflow-hidden">
                    <Table>
                        <TableHeader>
                            <TableRow className="border-border hover:bg-transparent">
                                <TableHead className="text-muted-foreground text-xs">Tenant</TableHead>
                                <TableHead className="text-muted-foreground text-xs">Question Asked</TableHead>
                                <TableHead className="text-muted-foreground text-xs text-right w-28">Times Asked</TableHead>
                                <TableHead className="text-muted-foreground text-xs w-40">Last Seen</TableHead>
                                <TableHead className="text-muted-foreground text-xs w-24">Status</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading
                                ? Array.from({ length: 8 }).map((_, i) => (
                                    <TableRow key={i} className="border-border">
                                        {Array.from({ length: 5 }).map((_, j) => (
                                            <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                                        ))}
                                    </TableRow>
                                ))
                                : gaps.map((g) => (
                                    <TableRow key={g.id} className="border-border hover:bg-secondary/30">
                                        <TableCell>
                                            <div>
                                                <p className="text-foreground/75 font-medium text-sm">{g.tenantName ?? "—"}</p>
                                                <p className="text-muted-foreground/80 font-mono text-[10px]">{g.tenantId.substring(0, 8)}</p>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <p className="text-foreground/75 text-sm line-clamp-2">{g.question}</p>
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <div className="flex items-center justify-end gap-1">
                                                <span className="text-amber-400 font-semibold text-sm">{g.timesAsked}</span>
                                                <span className="text-muted-foreground/80 text-xs">×</span>
                                            </div>
                                        </TableCell>
                                        <TableCell className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                                            {fmtTs(g.lastSeenAt)}
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant="outline" className={
                                                g.status === "open"
                                                    ? "text-[10px] border-amber-500/30 text-amber-400"
                                                    : "text-[10px] border-green-500/30 text-green-400"
                                            }>
                                                {g.status}
                                            </Badge>
                                        </TableCell>
                                    </TableRow>
                                ))}
                        </TableBody>
                    </Table>
                    {data?.total != null && data.total > gaps.length && (
                        <div className="px-4 py-3 border-t border-border">
                            <p className="text-xs text-muted-foreground/80">Showing top {gaps.length} of {data.total} gaps.</p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
