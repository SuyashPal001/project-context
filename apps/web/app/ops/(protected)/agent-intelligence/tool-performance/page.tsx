"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Wrench } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { OpsToolPerfResponse } from "@/components/platform/ops/types";

function SuccessBar({ value }: { value: number | null }) {
    if (value == null) return <span className="text-muted-foreground/80 text-xs">—</span>;
    const pct = Math.round(value);
    const color = pct >= 90 ? "bg-green-500" : pct >= 70 ? "bg-amber-500" : "bg-red-500";
    return (
        <div className="flex items-center gap-2">
            <div className="w-16 h-1.5 rounded-full bg-secondary overflow-hidden flex-shrink-0">
                <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
            </div>
            <span className={`text-sm font-medium ${pct >= 90 ? "text-green-400" : pct >= 70 ? "text-amber-400" : "text-red-400"}`}>
                {pct}%
            </span>
        </div>
    );
}

export default function ToolPerformancePage() {
    const { data, isLoading, isError, error } = useQuery<OpsToolPerfResponse>({
        queryKey: ["ops-tool-performance"],
        queryFn: () => api.get<OpsToolPerfResponse>("/api/v1/ops/agent-intelligence/tool-performance"),
    });

    const tools = data?.tools ?? [];

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight text-foreground">Tool Performance</h1>
                <p className="text-muted-foreground text-sm mt-1">Call counts, success rates, and latency for every tool across all agents.</p>
            </div>

            {isError && (
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" /><AlertTitle>Error</AlertTitle>
                    <AlertDescription>{error instanceof ApiError ? (error.data?.error ?? error.data?.message ?? `Server error ${error.status}`) : "Failed to load tool performance data."}</AlertDescription>
                </Alert>
            )}

            {!isLoading && !isError && tools.length === 0 && (
                <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground/80 border border-border rounded-xl bg-card">
                    <Wrench className="h-10 w-10 opacity-40" />
                    <p className="text-sm">No tool call data yet. Appears once agents use tools.</p>
                </div>
            )}

            {(isLoading || tools.length > 0) && (
                <div className="border border-border rounded-xl bg-card overflow-hidden">
                    <Table>
                        <TableHeader>
                            <TableRow className="border-border hover:bg-transparent">
                                <TableHead className="text-muted-foreground text-xs">Tool</TableHead>
                                <TableHead className="text-muted-foreground text-xs">Tenant</TableHead>
                                <TableHead className="text-muted-foreground text-xs text-right w-28">Calls</TableHead>
                                <TableHead className="text-muted-foreground text-xs w-40">Success Rate</TableHead>
                                <TableHead className="text-muted-foreground text-xs w-32">Avg Latency</TableHead>
                                <TableHead className="text-muted-foreground text-xs">Last Error</TableHead>
                                <TableHead className="text-muted-foreground text-xs w-36">Last Seen</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading
                                ? Array.from({ length: 8 }).map((_, i) => (
                                    <TableRow key={i} className="border-border">
                                        {Array.from({ length: 7 }).map((_, j) => (
                                            <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                                        ))}
                                    </TableRow>
                                ))
                                : tools.map((t, i) => (
                                    <TableRow key={`${t.toolName}-${t.tenantId}-${i}`} className="border-border hover:bg-secondary/30">
                                        <TableCell>
                                            <Badge variant="outline" className="font-mono text-[10px] border-input text-foreground/60">
                                                {t.toolName}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>
                                            <div>
                                                <p className="text-foreground/75 font-medium text-sm">{t.tenantName ?? "—"}</p>
                                                <p className="text-muted-foreground/80 font-mono text-[10px]">{t.tenantId.substring(0, 8)}</p>
                                            </div>
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <span className="text-foreground/90 font-medium text-sm">{t.callCount.toLocaleString()}</span>
                                        </TableCell>
                                        <TableCell>
                                            <SuccessBar value={t.successRate} />
                                        </TableCell>
                                        <TableCell>
                                            {t.avgLatencyMs != null
                                                ? <span className="text-foreground/60 text-sm font-mono">{Math.round(t.avgLatencyMs)}ms</span>
                                                : <span className="text-muted-foreground/80 text-xs">—</span>}
                                        </TableCell>
                                        <TableCell>
                                            {t.lastError
                                                ? <p className="text-red-400/80 text-xs font-mono line-clamp-1 max-w-xs">{t.lastError}</p>
                                                : <span className="text-muted-foreground/60 text-xs">none</span>}
                                        </TableCell>
                                        <TableCell className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                                            {(() => {
                                                if (!t.lastSeen) return "—";
                                                const d = new Date(t.lastSeen);
                                                if (isNaN(d.getTime())) return "—";
                                                return new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short" }).format(d);
                                            })()}
                                        </TableCell>
                                    </TableRow>
                                ))}
                        </TableBody>
                    </Table>
                </div>
            )}
        </div>
    );
}
