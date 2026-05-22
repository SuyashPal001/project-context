"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, ShieldAlert, ShieldX, Loader2, RefreshCw, CircleDashed } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

interface AgentFairnessRow {
    agent_id: string;
    agent_name: string;
    agent_type: string;
    agent_status: string;
    tenant_id: string;
    tenant_name: string;
    tenant_slug: string;
    review_id: string | null;
    overall_status: "pass" | "warn" | "fail" | null;
    run_at: string | null;
    check_results: unknown | null;
}

interface FairnessListResponse {
    agents: AgentFairnessRow[];
}

const statusConfig = {
    pass: { icon: ShieldCheck, badge: "bg-emerald-500/10 text-emerald-500", label: "Pass" },
    warn: { icon: ShieldAlert, badge: "bg-yellow-500/10 text-yellow-500", label: "Warning" },
    fail: { icon: ShieldX, badge: "bg-red-500/10 text-red-500", label: "Failed" },
};

export default function FairnessReviewsPage() {
    const queryClient = useQueryClient();
    const [statusFilter, setStatusFilter] = React.useState("all");
    const [runningId, setRunningId] = React.useState<string | null>(null);

    const { data, isLoading } = useQuery<FairnessListResponse>({
        queryKey: ["ops-fairness"],
        queryFn: () => api.get<FairnessListResponse>("/api/v1/ops/fairness"),
    });

    const runMutation = useMutation({
        mutationFn: (agentId: string) => {
            setRunningId(agentId);
            return api.post(`/api/v1/ops/fairness/${agentId}/run`, {});
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["ops-fairness"] });
            toast.success("Fairness check completed");
            setRunningId(null);
        },
        onError: () => {
            toast.error("Fairness check failed");
            setRunningId(null);
        },
    });

    const rows = data?.agents ?? [];
    const filtered = rows.filter(r => {
        if (statusFilter === "never") return !r.review_id;
        if (statusFilter === "all") return true;
        return r.overall_status === statusFilter;
    });

    const counts = {
        pass: rows.filter(r => r.overall_status === "pass").length,
        warn: rows.filter(r => r.overall_status === "warn").length,
        fail: rows.filter(r => r.overall_status === "fail").length,
        never: rows.filter(r => !r.review_id).length,
    };

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-xl font-semibold text-zinc-100">Fairness Reviews</h1>
                <p className="text-sm text-zinc-500 mt-1">RBI FREE-AI Sutra 1 — automated fairness checks across all agents</p>
            </div>

            <div className="flex gap-3">
                {[
                    { key: "never", label: "Never Checked", count: counts.never, color: "text-zinc-400" },
                    { key: "fail",  label: "Failed",         count: counts.fail,  color: "text-red-400" },
                    { key: "warn",  label: "Warning",        count: counts.warn,  color: "text-yellow-400" },
                    { key: "pass",  label: "Passed",         count: counts.pass,  color: "text-emerald-400" },
                ].map(s => (
                    <div key={s.key} className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                        <p className={`text-2xl font-bold ${s.color}`}>{s.count}</p>
                        <p className="text-xs text-zinc-500 mt-1">{s.label}</p>
                    </div>
                ))}
            </div>

            <div className="flex items-center gap-3">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-44 bg-zinc-900 border-zinc-700 text-zinc-300">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All agents</SelectItem>
                        <SelectItem value="never">Never checked</SelectItem>
                        <SelectItem value="fail">Failed</SelectItem>
                        <SelectItem value="warn">Warning</SelectItem>
                        <SelectItem value="pass">Passed</SelectItem>
                    </SelectContent>
                </Select>
                <p className="text-sm text-zinc-500">{filtered.length} agents</p>
            </div>

            <div className="rounded-lg border border-zinc-800 overflow-hidden">
                <Table>
                    <TableHeader>
                        <TableRow className="border-zinc-800 hover:bg-transparent">
                            <TableHead className="text-zinc-400">Agent</TableHead>
                            <TableHead className="text-zinc-400">Tenant</TableHead>
                            <TableHead className="text-zinc-400">Status</TableHead>
                            <TableHead className="text-zinc-400">Last Run</TableHead>
                            <TableHead className="text-zinc-400 text-right">Action</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {isLoading ? (
                            Array.from({ length: 5 }).map((_, i) => (
                                <TableRow key={i} className="border-zinc-800">
                                    <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                                    <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                                    <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                                    <TableCell><Skeleton className="h-4 w-20 ml-auto" /></TableCell>
                                </TableRow>
                            ))
                        ) : filtered.length === 0 ? (
                            <TableRow className="border-zinc-800">
                                <TableCell colSpan={5} className="text-center text-zinc-500 py-10">No agents found</TableCell>
                            </TableRow>
                        ) : filtered.map(row => {
                            const cfg = row.overall_status ? statusConfig[row.overall_status] : null;
                            const StatusIcon = cfg?.icon ?? CircleDashed;
                            const isRunning = runningId === row.agent_id;
                            return (
                                <TableRow key={row.agent_id} className="border-zinc-800 hover:bg-zinc-900/40">
                                    <TableCell>
                                        <p className="text-sm font-medium text-zinc-100">{row.agent_name}</p>
                                        <p className="text-xs text-zinc-500">{row.agent_type}</p>
                                    </TableCell>
                                    <TableCell>
                                        <p className="text-sm text-zinc-300">{row.tenant_name}</p>
                                        <p className="text-xs text-zinc-600">{row.tenant_slug}</p>
                                    </TableCell>
                                    <TableCell>
                                        {cfg ? (
                                            <Badge variant="secondary" className={cfg.badge}>
                                                <StatusIcon className="h-3 w-3 mr-1" />
                                                {cfg.label}
                                            </Badge>
                                        ) : (
                                            <span className="text-xs text-zinc-600">Never checked</span>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-sm text-zinc-400">
                                        {row.run_at ? new Date(row.run_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—"}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <Button size="sm" variant="outline" className="h-7 text-xs border-zinc-700"
                                            onClick={() => runMutation.mutate(row.agent_id)}
                                            disabled={isRunning || runMutation.isPending}>
                                            {isRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                                            {isRunning ? "" : "Run"}
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
}
