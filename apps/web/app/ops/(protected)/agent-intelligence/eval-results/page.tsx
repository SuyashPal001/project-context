"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Filter, Star, ChevronLeft, ChevronRight } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { OpsEvalResult, OpsEvalResultsResponse } from "@/components/platform/ops/types";

const PAGE_SIZE = 50;

const DIMENSIONS = [
    { value: "all",           label: "All Dimensions" },
    { value: "faithfulness",  label: "Faithfulness" },
    { value: "relevance",     label: "Relevance" },
    { value: "completeness",  label: "Completeness" },
];

const MAX_SCORES = [
    { value: "all", label: "Any Score" },
    { value: "4",   label: "≤ 4" },
    { value: "3",   label: "≤ 3" },
    { value: "2",   label: "≤ 2" },
    { value: "1",   label: "≤ 1" },
];

function ScoreBadge({ score }: { score: number | null }) {
    if (score == null) return <span className="text-muted-foreground/80 text-xs">—</span>;
    const pct = score * 100;
    const colorClass =
        pct >= 70 ? "border-green-500/30 text-green-400" :
        pct >= 40 ? "border-amber-500/30 text-amber-400" :
                    "border-red-500/30 text-red-400";
    return (
        <Badge variant="outline" className={`font-mono text-xs ${colorClass}`}>
            {score.toFixed(2)}
        </Badge>
    );
}

function fmtTs(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short" }).format(d);
}

export default function EvalResultsPage() {
    const [page, setPage]               = React.useState(1);
    const [tenantId, setTenantId]       = React.useState("");
    const [debouncedTenantId, setDebouncedTenantId] = React.useState("");
    const [dimension, setDimension]     = React.useState("all");
    const [maxScore, setMaxScore]       = React.useState("all");

    React.useEffect(() => {
        const t = setTimeout(() => { setDebouncedTenantId(tenantId); setPage(1); }, 400);
        return () => clearTimeout(t);
    }, [tenantId]);

    const queryKey = ["ops-eval-results", debouncedTenantId, dimension, maxScore, page] as const;

    const { data, isLoading, isError, error } = useQuery<OpsEvalResultsResponse>({
        queryKey,
        queryFn: () => {
            let url = `/api/v1/ops/evals/results?page=${page}&pageSize=${PAGE_SIZE}`;
            if (debouncedTenantId)    url += `&tenantId=${encodeURIComponent(debouncedTenantId)}`;
            if (dimension !== "all")  url += `&dimension=${encodeURIComponent(dimension)}`;
            if (maxScore  !== "all")  url += `&maxScore=${maxScore}`;
            return api.get<OpsEvalResultsResponse>(url);
        },
    });

    const results    = data?.results    ?? [];
    const totalPages = data?.totalPages ?? 1;

    const hasFilters = !!debouncedTenantId || dimension !== "all" || maxScore !== "all";

    function clearFilters() {
        setTenantId("");
        setDebouncedTenantId("");
        setDimension("all");
        setMaxScore("all");
        setPage(1);
    }

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight text-foreground">Eval Results</h1>
                <p className="text-muted-foreground text-sm mt-1">Individual AI-graded evaluation scores per message, across all tenants.</p>
            </div>

            {/* Filters */}
            <div className="flex flex-wrap items-center gap-3 p-4 border border-border rounded-xl bg-card">
                <div className="flex items-center gap-2 text-muted-foreground/80">
                    <Filter className="h-4 w-4" />
                </div>
                <Input
                    placeholder="Filter by tenant ID…"
                    value={tenantId}
                    onChange={(e) => setTenantId(e.target.value)}
                    className="w-64 bg-background border-input text-sm font-mono"
                />
                <Select value={dimension} onValueChange={(v) => { setDimension(v); setPage(1); }}>
                    <SelectTrigger className="w-44 bg-background border-input">
                        <SelectValue placeholder="Dimension" />
                    </SelectTrigger>
                    <SelectContent>
                        {DIMENSIONS.map((d) => (
                            <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Select value={maxScore} onValueChange={(v) => { setMaxScore(v); setPage(1); }}>
                    <SelectTrigger className="w-36 bg-background border-input">
                        <SelectValue placeholder="Max score" />
                    </SelectTrigger>
                    <SelectContent>
                        {MAX_SCORES.map((s) => (
                            <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                {hasFilters && (
                    <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground/90" onClick={clearFilters}>
                        Clear
                    </Button>
                )}
            </div>

            {isError && (
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" /><AlertTitle>Error</AlertTitle>
                    <AlertDescription>{error instanceof ApiError ? (error.data?.error ?? error.data?.message ?? `Server error ${error.status}`) : "Failed to load eval results."}</AlertDescription>
                </Alert>
            )}

            {!isLoading && !isError && results.length === 0 && (
                <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground/80 border border-border rounded-xl bg-card">
                    <Star className="h-10 w-10 opacity-40" />
                    <p className="text-sm">No eval results match your filters.</p>
                </div>
            )}

            {(isLoading || results.length > 0) && (
                <div className="border border-border rounded-xl bg-card overflow-hidden">
                    <Table>
                        <TableHeader>
                            <TableRow className="border-border hover:bg-transparent">
                                <TableHead className="text-muted-foreground text-xs">Tenant</TableHead>
                                <TableHead className="text-muted-foreground text-xs">Message Preview</TableHead>
                                <TableHead className="text-muted-foreground text-xs w-32">Dimension</TableHead>
                                <TableHead className="text-muted-foreground text-xs w-24">Score</TableHead>
                                <TableHead className="text-muted-foreground text-xs">Reasoning</TableHead>
                                <TableHead className="text-muted-foreground text-xs w-28">Mind</TableHead>
                                <TableHead className="text-muted-foreground text-xs w-36">Timestamp</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading
                                ? Array.from({ length: 10 }).map((_, i) => (
                                    <TableRow key={i} className="border-border">
                                        {Array.from({ length: 7 }).map((_, j) => (
                                            <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                                        ))}
                                    </TableRow>
                                ))
                                : results.map((r: OpsEvalResult) => (
                                    <TableRow key={r.id} className="border-border hover:bg-secondary/30">
                                        <TableCell>
                                            <div>
                                                <p className="text-foreground/75 font-medium text-sm">{r.tenantName ?? "—"}</p>
                                                <p className="text-muted-foreground/80 font-mono text-[10px]">{r.tenantId.substring(0, 8)}</p>
                                            </div>
                                        </TableCell>
                                        <TableCell className="max-w-[220px]">
                                            {r.messagePreview
                                                ? <p className="text-foreground/60 text-xs line-clamp-2">{r.messagePreview}</p>
                                                : <span className="text-muted-foreground/60 text-xs">—</span>}
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-wider border-input text-foreground/60">
                                                {r.dimension}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>
                                            <ScoreBadge score={r.score} />
                                        </TableCell>
                                        <TableCell className="max-w-[240px]">
                                            {r.reasoning
                                                ? <p className="text-muted-foreground text-xs line-clamp-2">{r.reasoning}</p>
                                                : <span className="text-muted-foreground/60 text-xs">—</span>}
                                        </TableCell>
                                        <TableCell>
                                            {r.model
                                                ? <span className="font-mono text-[10px] text-muted-foreground">{r.model}</span>
                                                : <span className="text-muted-foreground/60 text-xs">—</span>}
                                        </TableCell>
                                        <TableCell className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                                            {fmtTs(r.createdAt)}
                                        </TableCell>
                                    </TableRow>
                                ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            {!isLoading && !isError && results.length > 0 && (
                <div className="flex items-center justify-between px-1">
                    <p className="text-sm text-muted-foreground">
                        Page <span className="text-foreground/75 font-medium">{page}</span> of <span className="text-foreground/75 font-medium">{totalPages}</span>
                        {data?.total ? <span className="ml-2">({data.total.toLocaleString()} total)</span> : null}
                    </p>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="border-input">
                            <ChevronLeft className="mr-1 h-4 w-4" />Previous
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="border-input">
                            Next<ChevronRight className="ml-1 h-4 w-4" />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
