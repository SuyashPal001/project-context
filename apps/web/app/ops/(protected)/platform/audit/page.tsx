"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, FileText, ChevronLeft, ChevronRight, Filter } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { OpsAuditResponse, OpsAuditEntry } from "@/components/platform/ops/types";

const PAGE_SIZE = 50;

const ACTOR_TYPE_COLORS: Record<OpsAuditEntry["actorType"], string> = {
    human:  "border-blue-500/30 text-blue-400",
    agent:  "border-primary/30 text-primary",
    system: "border-input text-muted-foreground",
};

export default function AuditLogPage() {
    const [page, setPage] = React.useState(1);
    const [tenantId, setTenantId] = React.useState("");
    const [debouncedTenantId, setDebouncedTenantId] = React.useState("");
    const [actorType, setActorType] = React.useState("all");
    const [from, setFrom] = React.useState("");
    const [to, setTo] = React.useState("");

    React.useEffect(() => {
        const t = setTimeout(() => { setDebouncedTenantId(tenantId); setPage(1); }, 400);
        return () => clearTimeout(t);
    }, [tenantId]);

    const queryKey = ["ops-audit", debouncedTenantId, actorType, from, to, page] as const;

    const { data, isLoading, isError, error } = useQuery<OpsAuditResponse>({
        queryKey,
        queryFn: () => {
            let url = `/api/v1/ops/audit?page=${page}&pageSize=${PAGE_SIZE}`;
            if (debouncedTenantId) url += `&tenantId=${encodeURIComponent(debouncedTenantId)}`;
            if (actorType !== "all")   url += `&actorType=${actorType}`;
            if (from)                  url += `&from=${encodeURIComponent(from)}`;
            if (to)                    url += `&to=${encodeURIComponent(to)}`;
            return api.get<OpsAuditResponse>(url);
        },
    });

    const entries = data?.entries ?? [];
    const totalPages = data?.totalPages ?? 1;

    const fmtTs = (iso: string) =>
        new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));

    const actionColor = (action: string) => {
        if (action.includes("created") || action.includes("granted") || action.includes("reactivated"))
            return "text-green-400";
        if (action.includes("deleted") || action.includes("revoked") || action.includes("suspended"))
            return "text-red-400";
        if (action.includes("updated") || action.includes("changed"))
            return "text-amber-400";
        return "text-foreground/60";
    };

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight text-foreground">Audit Log</h1>
                <p className="text-muted-foreground text-sm mt-1">All actions across every tenant, newest first.</p>
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
                <Select value={actorType} onValueChange={(v) => { setActorType(v); setPage(1); }}>
                    <SelectTrigger className="w-36 bg-background border-input">
                        <SelectValue placeholder="Actor type" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All Actors</SelectItem>
                        <SelectItem value="human">Human</SelectItem>
                        <SelectItem value="agent">Agent</SelectItem>
                        <SelectItem value="system">System</SelectItem>
                    </SelectContent>
                </Select>
                <div className="flex items-center gap-2">
                    <Input
                        type="datetime-local"
                        value={from}
                        onChange={(e) => { setFrom(e.target.value); setPage(1); }}
                        className="w-48 bg-background border-input text-sm text-foreground/60"
                    />
                    <span className="text-muted-foreground/80 text-sm">to</span>
                    <Input
                        type="datetime-local"
                        value={to}
                        onChange={(e) => { setTo(e.target.value); setPage(1); }}
                        className="w-48 bg-background border-input text-sm text-foreground/60"
                    />
                </div>
                {(debouncedTenantId || actorType !== "all" || from || to) && (
                    <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground/90"
                        onClick={() => { setTenantId(""); setDebouncedTenantId(""); setActorType("all"); setFrom(""); setTo(""); setPage(1); }}>
                        Clear
                    </Button>
                )}
            </div>

            {isError && (
                <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" /><AlertTitle>Error</AlertTitle>
                    <AlertDescription>{error instanceof ApiError ? (error.data?.error ?? error.data?.message ?? `Server error ${error.status}`) : "Failed to load audit log."}</AlertDescription>
                </Alert>
            )}

            {!isLoading && !isError && entries.length === 0 && (
                <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground/80 border border-border rounded-xl bg-card">
                    <FileText className="h-10 w-10 opacity-40" />
                    <p className="text-sm">No audit entries match your filters.</p>
                </div>
            )}

            {(isLoading || entries.length > 0) && (
                <div className="border border-border rounded-xl bg-card overflow-hidden">
                    <Table>
                        <TableHeader>
                            <TableRow className="border-border hover:bg-transparent">
                                <TableHead className="text-muted-foreground text-xs w-40">Timestamp</TableHead>
                                <TableHead className="text-muted-foreground text-xs">Tenant</TableHead>
                                <TableHead className="text-muted-foreground text-xs">Actor</TableHead>
                                <TableHead className="text-muted-foreground text-xs">Action</TableHead>
                                <TableHead className="text-muted-foreground text-xs">Resource</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading
                                ? Array.from({ length: 10 }).map((_, i) => (
                                    <TableRow key={i} className="border-border">
                                        {Array.from({ length: 5 }).map((_, j) => <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>)}
                                    </TableRow>
                                ))
                                : entries.map((e) => (
                                    <TableRow key={e.id} className="border-border hover:bg-secondary/30">
                                        <TableCell className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">{fmtTs(e.createdAt)}</TableCell>
                                        <TableCell>
                                            <div>
                                                <p className="text-foreground/75 text-sm font-medium">{e.tenantName ?? "—"}</p>
                                                <p className="text-muted-foreground/80 font-mono text-[10px]">{e.tenantId.substring(0, 8)}</p>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex flex-col gap-1">
                                                <Badge variant="outline" className={`w-fit text-[10px] font-medium ${ACTOR_TYPE_COLORS[e.actorType]}`}>
                                                    {e.actorType}
                                                </Badge>
                                                <p className="font-mono text-[10px] text-muted-foreground/80">{e.actorId.substring(0, 8)}</p>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <span className={`text-sm font-mono font-medium ${actionColor(e.action)}`}>
                                                {e.action}
                                            </span>
                                        </TableCell>
                                        <TableCell>
                                            <div>
                                                <p className="text-foreground/60 text-sm">{e.resource}</p>
                                                {e.resourceId && (
                                                    <p className="font-mono text-[10px] text-muted-foreground/80">{e.resourceId.substring(0, 8)}</p>
                                                )}
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            {!isLoading && !isError && entries.length > 0 && (
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
