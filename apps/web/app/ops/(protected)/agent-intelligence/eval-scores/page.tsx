"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Star, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { OpsEvalScoresResponse, OpsEvalScore } from "@/components/platform/ops/types";

function pct(v: number | null): string {
    if (v == null) return "—";
    return `${(v * 100).toFixed(1)}%`;
}

function TrendIcon({ trend }: { trend: OpsEvalScore["trend"] }) {
    if (trend === "up")     return <TrendingUp   className="h-3.5 w-3.5 text-green-400" />;
    if (trend === "down")   return <TrendingDown className="h-3.5 w-3.5 text-red-400" />;
    return <Minus className="h-3.5 w-3.5 text-zinc-600" />;
}

function ScoreBar({ value }: { value: number | null }) {
    if (value == null) return <span className="text-zinc-600 text-xs">—</span>;
    const pctVal = Math.round(value * 100);
    const color = pctVal >= 70 ? "bg-green-500" : pctVal >= 40 ? "bg-amber-500" : "bg-red-500";
    return (
        <div className="flex items-center gap-2">
            <div className="w-20 h-1.5 rounded-full bg-zinc-800 overflow-hidden flex-shrink-0">
                <div className={`h-full rounded-full ${color}`} style={{ width: `${pctVal}%` }} />
            </div>
            <span className="text-sm font-medium text-zinc-300">{pctVal}%</span>
        </div>
    );
}

export default function EvalScoresPage() {
    const { data, isLoading, isError, error } = useQuery<OpsEvalScoresResponse>({
        queryKey: ["ops-eval-scores"],
        queryFn: () => api.get<OpsEvalScoresResponse>("/api/v1/ops/agent-intelligence/eval-scores"),
    });

    const scores = data?.scores ?? [];

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight text-zinc-50">Eval Scores</h1>
                <p className="text-zinc-500 text-sm mt-1">Quality scores, RAG hit rates, and user feedback per tenant.</p>
            </div>

            {isError && (
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" /><AlertTitle>Error</AlertTitle>
                    <AlertDescription>{error instanceof ApiError ? (error.data?.error ?? error.data?.message ?? `Server error ${error.status}`) : "Failed to load eval scores."}</AlertDescription>
                </Alert>
            )}

            {!isLoading && !isError && scores.length === 0 && (
                <div className="flex flex-col items-center gap-3 py-24 text-zinc-600 border border-zinc-800 rounded-xl bg-zinc-900">
                    <Star className="h-10 w-10 opacity-40" />
                    <p className="text-sm">No eval data yet. Scores appear once conversations are evaluated.</p>
                </div>
            )}

            {(isLoading || scores.length > 0) && (
                <div className="border border-zinc-800 rounded-xl bg-zinc-900 overflow-hidden">
                    <Table>
                        <TableHeader>
                            <TableRow className="border-zinc-800 hover:bg-transparent">
                                <TableHead className="text-zinc-500 text-xs">Tenant</TableHead>
                                <TableHead className="text-zinc-500 text-xs">Avg Quality Score</TableHead>
                                <TableHead className="text-zinc-500 text-xs">RAG Hit Rate</TableHead>
                                <TableHead className="text-zinc-500 text-xs">Thumbs Up</TableHead>
                                <TableHead className="text-zinc-500 text-xs w-20">Trend</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading
                                ? Array.from({ length: 6 }).map((_, i) => (
                                    <TableRow key={i} className="border-zinc-800">
                                        {Array.from({ length: 5 }).map((_, j) => (
                                            <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                                        ))}
                                    </TableRow>
                                ))
                                : scores.map((s) => (
                                    <TableRow key={s.tenantId} className="border-zinc-800 hover:bg-zinc-800/30">
                                        <TableCell>
                                            <div>
                                                <p className="text-zinc-200 font-medium text-sm">{s.tenantName ?? "—"}</p>
                                                <p className="text-zinc-600 font-mono text-[10px]">{s.tenantId.substring(0, 8)}</p>
                                            </div>
                                        </TableCell>
                                        <TableCell><ScoreBar value={s.avgQualityScore} /></TableCell>
                                        <TableCell>
                                            <span className="text-sm text-zinc-300">{pct(s.ragHitRate)}</span>
                                        </TableCell>
                                        <TableCell>
                                            <span className="text-sm text-zinc-300">{pct(s.thumbsUpPct)}</span>
                                        </TableCell>
                                        <TableCell>
                                            <TrendIcon trend={s.trend} />
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
