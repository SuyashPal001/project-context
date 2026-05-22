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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface AgentFairnessRow { agent_id: string; agent_name: string; agent_type: string; tenant_id: string; tenant_name: string; tenant_slug: string; review_id: string | null; overall_status: "pass" | "warn" | "fail" | null; run_at: string | null; check_results: unknown | null }
interface ResponseAuditRow { id: string; tenantId: string; resourceId: string | null; metadata: { overallStatus: string; checkResults: { checkId: string; status: string; flags?: string[]; violations?: string[] }[]; responseLength: number; toolsUsed: number } | null; createdAt: string }

const statusConfig = {
    pass: { icon: ShieldCheck, badge: "bg-emerald-500/10 text-emerald-500", label: "Pass" },
    warn: { icon: ShieldAlert, badge: "bg-yellow-500/10 text-yellow-500", label: "Warn" },
    fail: { icon: ShieldX, badge: "bg-red-500/10 text-red-500", label: "Fail" },
};

function StatusBadge({ status }: { status: string | null | undefined }) {
    if (!status || !(status in statusConfig)) return <span className="text-xs text-zinc-600">—</span>;
    const cfg = statusConfig[status as keyof typeof statusConfig];
    return <Badge variant="secondary" className={cfg.badge}><cfg.icon className="h-3 w-3 mr-1" />{cfg.label}</Badge>;
}

export default function FairnessReviewsPage() {
    const queryClient = useQueryClient();
    const [statusFilter, setStatusFilter] = React.useState("all");
    const [runningId, setRunningId] = React.useState<string | null>(null);

    const { data, isLoading } = useQuery<{ agents: AgentFairnessRow[] }>({
        queryKey: ["ops-fairness"],
        queryFn: () => api.get("/api/v1/ops/fairness"),
    });
    const { data: auditsData, isLoading: auditsLoading } = useQuery<{ audits: ResponseAuditRow[] }>({
        queryKey: ["ops-fairness-response-audits"],
        queryFn: () => api.get("/api/v1/ops/fairness/response-audits"),
        refetchInterval: 30_000,
    });

    const runMutation = useMutation({
        mutationFn: (agentId: string) => { setRunningId(agentId); return api.post(`/api/v1/ops/fairness/${agentId}/run`, {}); },
        onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["ops-fairness"] }); toast.success("Fairness check completed"); setRunningId(null); },
        onError: () => { toast.error("Fairness check failed"); setRunningId(null); },
    });

    const rows = data?.agents ?? [];
    const filtered = rows.filter(r => statusFilter === "all" ? true : statusFilter === "never" ? !r.review_id : r.overall_status === statusFilter);
    const counts = { pass: rows.filter(r => r.overall_status === "pass").length, warn: rows.filter(r => r.overall_status === "warn").length, fail: rows.filter(r => r.overall_status === "fail").length, never: rows.filter(r => !r.review_id).length };
    const audits = auditsData?.audits ?? [];
    const failCount = audits.filter(a => a.metadata?.overallStatus === "fail").length;
    const warnCount = audits.filter(a => a.metadata?.overallStatus === "warn").length;

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-xl font-semibold text-zinc-100">Fairness Reviews</h1>
                <p className="text-sm text-zinc-500 mt-1">RBI FREE-AI Sutra 1 — automated fairness checks across all agents</p>
            </div>
            <Tabs defaultValue="runtime">
                <TabsList className="bg-zinc-900 border border-zinc-800">
                    <TabsTrigger value="runtime">Runtime Audits {failCount > 0 && <span className="ml-1.5 text-red-400 text-xs">({failCount} fail)</span>}</TabsTrigger>
                    <TabsTrigger value="config">Config Reviews</TabsTrigger>
                </TabsList>

                <TabsContent value="runtime" className="space-y-4 mt-4">
                    <p className="text-xs text-zinc-500">Automated checks on every agent response. Refreshes every 30s. Populated after Lambda deploy.</p>
                    {warnCount + failCount > 0 && <div className="flex gap-2 text-xs"><span className="text-red-400">{failCount} fail</span><span className="text-yellow-400">{warnCount} warn</span><span className="text-zinc-500">in last 100 responses</span></div>}
                    <div className="rounded-lg border border-zinc-800 overflow-hidden">
                        <Table>
                            <TableHeader>
                                <TableRow className="border-zinc-800 hover:bg-transparent">
                                    <TableHead className="text-zinc-400">Time</TableHead>
                                    <TableHead className="text-zinc-400">Status</TableHead>
                                    <TableHead className="text-zinc-400">Conversation</TableHead>
                                    <TableHead className="text-zinc-400">Flags / Violations</TableHead>
                                    <TableHead className="text-zinc-400 text-right">Length</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {auditsLoading ? Array.from({ length: 5 }).map((_, i) => (
                                    <TableRow key={i} className="border-zinc-800"><TableCell><Skeleton className="h-4 w-28" /></TableCell><TableCell><Skeleton className="h-4 w-16" /></TableCell><TableCell><Skeleton className="h-4 w-32" /></TableCell><TableCell><Skeleton className="h-4 w-40" /></TableCell><TableCell><Skeleton className="h-4 w-12 ml-auto" /></TableCell></TableRow>
                                )) : audits.length === 0 ? (
                                    <TableRow className="border-zinc-800"><TableCell colSpan={5} className="text-center text-zinc-500 py-10 text-sm">No runtime audits yet — deploy Lambda to activate Sutra 1</TableCell></TableRow>
                                ) : audits.map(row => {
                                    const status = row.metadata?.overallStatus ?? 'pass';
                                    const flags = (row.metadata?.checkResults ?? []).flatMap(r => [...(r.flags ?? []), ...(r.violations ?? [])]).filter(Boolean);
                                    return (
                                        <TableRow key={row.id} className="border-zinc-800 hover:bg-zinc-900/40">
                                            <TableCell className="text-xs text-zinc-400">{new Date(row.createdAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</TableCell>
                                            <TableCell><StatusBadge status={status} /></TableCell>
                                            <TableCell className="text-xs text-zinc-500 font-mono">{row.resourceId?.slice(0, 8) ?? "—"}</TableCell>
                                            <TableCell className="text-xs text-zinc-400">{flags.length > 0 ? flags.join(", ") : <span className="text-zinc-600">none</span>}</TableCell>
                                            <TableCell className="text-right text-xs text-zinc-500">{row.metadata?.responseLength ?? "—"}</TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </div>
                </TabsContent>

                <TabsContent value="config" className="space-y-4 mt-4">
                    <div className="flex gap-3">
                        {[{ key: "never", label: "Never Checked", count: counts.never, color: "text-zinc-400" }, { key: "fail", label: "Failed", count: counts.fail, color: "text-red-400" }, { key: "warn", label: "Warning", count: counts.warn, color: "text-yellow-400" }, { key: "pass", label: "Passed", count: counts.pass, color: "text-emerald-400" }].map(s => (
                            <div key={s.key} className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                                <p className={`text-2xl font-bold ${s.color}`}>{s.count}</p>
                                <p className="text-xs text-zinc-500 mt-1">{s.label}</p>
                            </div>
                        ))}
                    </div>
                    <div className="flex items-center gap-3">
                        <Select value={statusFilter} onValueChange={setStatusFilter}>
                            <SelectTrigger className="w-44 bg-zinc-900 border-zinc-700 text-zinc-300"><SelectValue /></SelectTrigger>
                            <SelectContent><SelectItem value="all">All agents</SelectItem><SelectItem value="never">Never checked</SelectItem><SelectItem value="fail">Failed</SelectItem><SelectItem value="warn">Warning</SelectItem><SelectItem value="pass">Passed</SelectItem></SelectContent>
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
                                {isLoading ? Array.from({ length: 5 }).map((_, i) => (
                                    <TableRow key={i} className="border-zinc-800"><TableCell><Skeleton className="h-4 w-32" /></TableCell><TableCell><Skeleton className="h-4 w-24" /></TableCell><TableCell><Skeleton className="h-4 w-16" /></TableCell><TableCell><Skeleton className="h-4 w-28" /></TableCell><TableCell><Skeleton className="h-4 w-20 ml-auto" /></TableCell></TableRow>
                                )) : filtered.length === 0 ? (
                                    <TableRow className="border-zinc-800"><TableCell colSpan={5} className="text-center text-zinc-500 py-10">No agents found</TableCell></TableRow>
                                ) : filtered.map(row => {
                                    const isRunning = runningId === row.agent_id;
                                    return (
                                        <TableRow key={row.agent_id} className="border-zinc-800 hover:bg-zinc-900/40">
                                            <TableCell><p className="text-sm font-medium text-zinc-100">{row.agent_name}</p><p className="text-xs text-zinc-500">{row.agent_type}</p></TableCell>
                                            <TableCell><p className="text-sm text-zinc-300">{row.tenant_name}</p><p className="text-xs text-zinc-600">{row.tenant_slug}</p></TableCell>
                                            <TableCell><StatusBadge status={row.overall_status} /></TableCell>
                                            <TableCell className="text-sm text-zinc-400">{row.run_at ? new Date(row.run_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—"}</TableCell>
                                            <TableCell className="text-right"><Button size="sm" variant="outline" className="h-7 text-xs border-zinc-700" onClick={() => runMutation.mutate(row.agent_id)} disabled={isRunning || runMutation.isPending}>{isRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}{isRunning ? "" : "Run"}</Button></TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </div>
                </TabsContent>
            </Tabs>
        </div>
    );
}
