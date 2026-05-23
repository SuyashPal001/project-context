"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
    Building2, BrainCircuit, AlertCircle, TrendingUp,
    DollarSign, MessageCircleQuestion, FileText,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { api, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type {
    OpsOverviewStats, OpsAuditResponse, OpsAuditEntry,
    OpsKnowledgeGapsResponse,
} from "@/components/platform/ops/types";

const ACTOR_COLORS: Record<OpsAuditEntry["actorType"], string> = {
    human:  "border-blue-500/30 text-blue-400",
    agent:  "border-violet-500/30 text-violet-400",
    system: "border-zinc-700 text-zinc-500",
};

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
        <div className="flex flex-col gap-3 p-5 rounded-xl border border-zinc-800 bg-zinc-900">
            <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">{label}</p>
                <Icon className="h-4 w-4 text-zinc-600" />
            </div>
            {loading
                ? <Skeleton className="h-8 w-24" />
                : <p className="text-3xl font-bold tracking-tight text-zinc-50">{value ?? "—"}</p>}
            {sub && <p className="text-xs text-zinc-600">{sub}</p>}
        </div>
    );
}

function actionColor(action: string) {
    if (action.includes("created") || action.includes("granted") || action.includes("reactivated"))
        return "text-green-400";
    if (action.includes("deleted") || action.includes("revoked") || action.includes("suspended"))
        return "text-red-400";
    if (action.includes("updated") || action.includes("changed"))
        return "text-amber-400";
    return "text-zinc-400";
}

function fmtTs(iso: string | null | undefined) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short" }).format(d);
}

export default function OpsOverviewPage() {
    const { data: stats, isLoading: statsLoading, isError: statsError, error: statsErr } = useQuery<OpsOverviewStats>({
        queryKey: ["ops-overview"],
        queryFn: () => api.get<OpsOverviewStats>("/api/v1/ops/overview"),
    });

    const { data: auditData, isLoading: auditLoading, isError: auditError, error: auditErr } = useQuery<OpsAuditResponse>({
        queryKey: ["ops-overview-audit"],
        queryFn: () => api.get<OpsAuditResponse>("/api/v1/ops/audit?page=1&pageSize=10"),
    });

    const { data: gapsData, isLoading: gapsLoading, isError: gapsError, error: gapsErr } = useQuery<OpsKnowledgeGapsResponse>({
        queryKey: ["ops-overview-gaps"],
        queryFn: () => api.get<OpsKnowledgeGapsResponse>("/api/v1/ops/agent-intelligence/knowledge-gaps?limit=5"),
    });

    const entries = auditData?.entries ?? [];
    const gaps = gapsData?.gaps?.slice(0, 5) ?? [];

    const apiErrMsg = (err: unknown) =>
        err instanceof ApiError ? (err.data?.error ?? err.data?.message ?? `Server error ${err.status}`) : undefined;

    return (
        <div className="space-y-8">
            <div>
                <h1 className="text-2xl font-bold tracking-tight text-zinc-50">Mission Control</h1>
                <p className="text-zinc-500 text-sm mt-1">Platform overview across all tenants.</p>
            </div>

            {statsError && (
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" /><AlertTitle>Failed to load overview stats</AlertTitle>
                    <AlertDescription>{apiErrMsg(statsErr) ?? "Could not load platform stats."}</AlertDescription>
                </Alert>
            )}

            {/* Stat cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard
                    label="Active Tenants"
                    value={stats?.activeTenants}
                    icon={Building2}
                    loading={statsLoading}
                />
                <StatCard
                    label="Avg Eval Score"
                    value={stats?.avgEvalScore != null ? `${(parseFloat(String(stats.avgEvalScore)) * 100).toFixed(0)}%` : null}
                    icon={TrendingUp}
                    loading={statsLoading}
                />
                <StatCard
                    label="Open Knowledge Gaps"
                    value={stats?.openKnowledgeGaps}
                    icon={MessageCircleQuestion}
                    loading={statsLoading}
                />
                <StatCard
                    label="Cost This Month"
                    value={stats?.totalCostThisMonth != null
                        ? `$${parseFloat(String(stats.totalCostThisMonth)).toFixed(2)}`
                        : null}
                    icon={DollarSign}
                    loading={statsLoading}
                />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Recent audit entries */}
                <div className="border border-zinc-800 rounded-xl bg-zinc-900 overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
                        <FileText className="h-4 w-4 text-zinc-600" />
                        <p className="text-sm font-semibold text-zinc-200">Recent Activity</p>
                        <span className="text-xs text-zinc-600 ml-auto">last 10 events</span>
                    </div>
                    <div className="divide-y divide-zinc-800/60">
                        {auditLoading
                            ? Array.from({ length: 6 }).map((_, i) => (
                                <div key={i} className="flex items-center gap-3 px-4 py-3">
                                    <Skeleton className="h-3 w-full" />
                                </div>
                            ))
                            : auditError
                                ? <p className="px-4 py-8 text-sm text-red-400/80 text-center">{apiErrMsg(auditErr) ?? "Failed to load recent activity."}</p>
                            : entries.length === 0
                                ? <p className="px-4 py-8 text-sm text-zinc-600 text-center">No recent activity.</p>
                                : entries.map((e) => (
                                    <div key={e.id} className="flex items-start gap-3 px-4 py-3 hover:bg-zinc-800/30 transition-colors">
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className={`text-xs font-mono font-medium ${actionColor(e.action)}`}>{e.action}</span>
                                                <Badge variant="outline" className={`text-[9px] ${ACTOR_COLORS[e.actorType]}`}>{e.actorType}</Badge>
                                            </div>
                                            <p className="text-[11px] text-zinc-600 mt-0.5 truncate">
                                                {e.tenantName ?? e.tenantId.substring(0, 8)} · {e.resource}
                                            </p>
                                        </div>
                                        <span className="text-[10px] text-zinc-700 whitespace-nowrap flex-shrink-0 mt-0.5">{fmtTs(e.createdAt)}</span>
                                    </div>
                                ))}
                    </div>
                </div>

                {/* Top knowledge gaps */}
                <div className="border border-zinc-800 rounded-xl bg-zinc-900 overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
                        <MessageCircleQuestion className="h-4 w-4 text-zinc-600" />
                        <p className="text-sm font-semibold text-zinc-200">Top Knowledge Gaps</p>
                        <span className="text-xs text-zinc-600 ml-auto">this week</span>
                    </div>
                    <div className="divide-y divide-zinc-800/60">
                        {gapsLoading
                            ? Array.from({ length: 5 }).map((_, i) => (
                                <div key={i} className="flex items-center gap-3 px-4 py-3">
                                    <Skeleton className="h-3 w-full" />
                                </div>
                            ))
                            : gapsError
                                ? <p className="px-4 py-8 text-sm text-red-400/80 text-center">{apiErrMsg(gapsErr) ?? "Failed to load knowledge gaps."}</p>
                            : gaps.length === 0
                                ? <p className="px-4 py-8 text-sm text-zinc-600 text-center">No knowledge gaps detected.</p>
                                : gaps.map((g) => (
                                    <div key={`${g.tenantId}-${g.question}`} className="flex items-start gap-3 px-4 py-3 hover:bg-zinc-800/30 transition-colors">
                                        <AlertCircle className="h-3.5 w-3.5 text-amber-500/60 flex-shrink-0 mt-0.5" />
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm text-zinc-300 line-clamp-1">{g.question}</p>
                                            <p className="text-[11px] text-zinc-600 mt-0.5">{g.tenantName ?? g.tenantId.substring(0, 8)}</p>
                                        </div>
                                        <span className="text-xs text-zinc-600 flex-shrink-0">×{g.timesAsked}</span>
                                    </div>
                                ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
