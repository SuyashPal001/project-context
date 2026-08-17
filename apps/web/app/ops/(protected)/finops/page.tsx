"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
    DollarSign, Zap, BarChart3, Building2, AlertCircle,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { OpsFinopsResponse } from "@/components/platform/ops/types";

type Period = "today" | "7d" | "30d";

const PERIODS: { value: Period; label: string }[] = [
    { value: "today", label: "Today" },
    { value: "7d",    label: "7d" },
    { value: "30d",   label: "30d" },
];

function fmtCost(n: number | string | null | undefined): string {
    const v = parseFloat(String(n ?? '0'));
    if (isNaN(v) || v === 0) return "$0.00";
    if (v < 0.001) return `$${v.toFixed(6)}`;
    if (v < 0.01)  return `$${v.toFixed(4)}`;
    return `$${v.toFixed(4)}`;
}

function fmtTokens(n: number | string | null | undefined): string {
    if (n == null || n === '') return "—";
    const v = parseFloat(String(n));
    if (isNaN(v)) return "—";
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}K`;
    return String(Math.round(v));
}

function fmtTs(iso: string | null | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short" }).format(d);
}

function StatCard({
    label, value, icon: Icon, sub, loading,
}: {
    label: string;
    value: React.ReactNode;
    icon: React.ElementType;
    sub?: string;
    loading?: boolean;
}) {
    return (
        <div className="flex flex-col gap-3 p-5 rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</p>
                <Icon className="h-4 w-4 text-muted-foreground/80" />
            </div>
            {loading
                ? <Skeleton className="h-8 w-24" />
                : <p className="text-3xl font-bold tracking-tight text-foreground">{value ?? "—"}</p>}
            {sub && <p className="text-xs text-muted-foreground/80">{sub}</p>}
        </div>
    );
}

export default function FinOpsPage() {
    const [period, setPeriod] = React.useState<Period>("30d");

    const { data, isLoading, isError, error } = useQuery<OpsFinopsResponse>({
        queryKey: ["ops-finops", period],
        queryFn: () => api.get<OpsFinopsResponse>(`/api/v1/ops/finops?period=${period}`),
    });

    const byTenant        = data?.byTenant        ?? [];
    const topConversations = data?.topConversations ?? [];

    return (
        <div className="space-y-8">
            {/* Header + period selector */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-foreground">FinOps</h1>
                    <p className="text-muted-foreground text-sm mt-1">Platform-wide LLM cost and token usage.</p>
                </div>
                <div className="flex items-center gap-1 p-1 rounded-lg border border-border bg-card w-fit">
                    {PERIODS.map(({ value, label }) => (
                        <button
                            key={value}
                            onClick={() => setPeriod(value)}
                            className={[
                                "px-4 py-1.5 rounded-md text-sm font-medium transition-colors",
                                period === value
                                    ? "bg-input text-foreground"
                                    : "text-muted-foreground hover:text-foreground/90",
                            ].join(" ")}
                        >
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            {isError && (
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertTitle>Error</AlertTitle>
                    <AlertDescription>{error instanceof ApiError ? (error.data?.error ?? error.data?.message ?? `Server error ${error.status}`) : "Failed to load FinOps data."}</AlertDescription>
                </Alert>
            )}

            {/* Stat cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard
                    label="Total Platform Cost"
                    value={data ? fmtCost(data.totalCost) : null}
                    icon={DollarSign}
                    loading={isLoading}
                />
                <StatCard
                    label="Total Tokens"
                    value={data ? fmtTokens(parseFloat(String(data.totalInputTokens ?? '0')) + parseFloat(String(data.totalOutputTokens ?? '0'))) : null}
                    icon={Zap}
                    sub={data ? `${fmtTokens(data.totalInputTokens)} in · ${fmtTokens(data.totalOutputTokens)} out` : undefined}
                    loading={isLoading}
                />
                <StatCard
                    label="Avg Cost / Conversation"
                    value={data ? fmtCost(data.avgCostPerConversation) : null}
                    icon={BarChart3}
                    loading={isLoading}
                />
                <StatCard
                    label="Tenants with Spend"
                    value={data?.activeTenantsWithSpend ?? null}
                    icon={Building2}
                    loading={isLoading}
                />
            </div>

            {/* Per-tenant spend */}
            <section className="space-y-3">
                <h2 className="text-sm font-semibold text-foreground/60 uppercase tracking-wider">Spend by Tenant</h2>

                {!isLoading && !isError && byTenant.length === 0 && (
                    <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground/80 border border-border rounded-xl bg-card">
                        <DollarSign className="h-10 w-10 opacity-40" />
                        <p className="text-sm">No cost data for this period.</p>
                    </div>
                )}

                {(isLoading || byTenant.length > 0) && (
                    <div className="border border-border rounded-xl bg-card overflow-hidden">
                        <Table>
                            <TableHeader>
                                <TableRow className="border-border hover:bg-transparent">
                                    <TableHead className="text-muted-foreground text-xs">Tenant</TableHead>
                                    <TableHead className="text-muted-foreground text-xs text-right w-28">Conversations</TableHead>
                                    <TableHead className="text-muted-foreground text-xs text-right w-32">Input Tokens</TableHead>
                                    <TableHead className="text-muted-foreground text-xs text-right w-32">Output Tokens</TableHead>
                                    <TableHead className="text-muted-foreground text-xs text-right w-32">Total Cost</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {isLoading
                                    ? Array.from({ length: 6 }).map((_, i) => (
                                        <TableRow key={i} className="border-border">
                                            {Array.from({ length: 5 }).map((_, j) => (
                                                <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                                            ))}
                                        </TableRow>
                                    ))
                                    : byTenant.map((row) => (
                                        <TableRow key={row.tenantId} className="border-border hover:bg-secondary/30">
                                            <TableCell>
                                                <div>
                                                    <p className="text-foreground/90 font-medium text-sm">{row.tenantName ?? "—"}</p>
                                                    <p className="text-muted-foreground/80 font-mono text-[10px]">{row.tenantId.substring(0, 8)}</p>
                                                </div>
                                            </TableCell>
                                            <TableCell className="text-right text-foreground/75 text-sm font-medium">
                                                {row.conversationCount.toLocaleString()}
                                            </TableCell>
                                            <TableCell className="text-right font-mono text-xs text-foreground/60">
                                                {fmtTokens(row.inputTokens)}
                                            </TableCell>
                                            <TableCell className="text-right font-mono text-xs text-foreground/60">
                                                {fmtTokens(row.outputTokens)}
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <span className="font-mono text-sm font-semibold text-foreground">
                                                    {fmtCost(row.cost)}
                                                </span>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </section>

            {/* Most expensive conversations */}
            <section className="space-y-3">
                <h2 className="text-sm font-semibold text-foreground/60 uppercase tracking-wider">Most Expensive Conversations</h2>

                {!isLoading && !isError && topConversations.length === 0 && (
                    <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground/80 border border-border rounded-xl bg-card">
                        <BarChart3 className="h-10 w-10 opacity-40" />
                        <p className="text-sm">No conversation data for this period.</p>
                    </div>
                )}

                {(isLoading || topConversations.length > 0) && (
                    <div className="border border-border rounded-xl bg-card overflow-hidden">
                        <Table>
                            <TableHeader>
                                <TableRow className="border-border hover:bg-transparent">
                                    <TableHead className="text-muted-foreground text-xs">Conversation</TableHead>
                                    <TableHead className="text-muted-foreground text-xs">Tenant</TableHead>
                                    <TableHead className="text-muted-foreground text-xs w-40">Timestamp</TableHead>
                                    <TableHead className="text-muted-foreground text-xs text-right w-28">Input</TableHead>
                                    <TableHead className="text-muted-foreground text-xs text-right w-28">Output</TableHead>
                                    <TableHead className="text-muted-foreground text-xs text-right w-28">Cost</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {isLoading
                                    ? Array.from({ length: 8 }).map((_, i) => (
                                        <TableRow key={i} className="border-border">
                                            {Array.from({ length: 6 }).map((_, j) => (
                                                <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                                            ))}
                                        </TableRow>
                                    ))
                                    : topConversations.map((row, idx) => (
                                        <TableRow key={`${row.conversationId}-${idx}`} className="border-border hover:bg-secondary/30">
                                            <TableCell>
                                                <Badge variant="outline" className="font-mono text-[10px] border-input text-muted-foreground">
                                                    {row.conversationId.substring(0, 8)}
                                                </Badge>
                                            </TableCell>
                                            <TableCell>
                                                <div>
                                                    <p className="text-foreground/75 text-sm">{row.tenantName ?? "—"}</p>
                                                    <p className="text-muted-foreground/80 font-mono text-[10px]">{row.tenantId.substring(0, 8)}</p>
                                                </div>
                                            </TableCell>
                                            <TableCell className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                                                {fmtTs(row.createdAt)}
                                            </TableCell>
                                            <TableCell className="text-right font-mono text-xs text-foreground/60">
                                                {fmtTokens(row.inputTokens)}
                                            </TableCell>
                                            <TableCell className="text-right font-mono text-xs text-foreground/60">
                                                {fmtTokens(row.outputTokens)}
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <span className="font-mono text-sm font-semibold text-foreground">
                                                    {fmtCost(row.cost)}
                                                </span>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </section>
        </div>
    );
}
