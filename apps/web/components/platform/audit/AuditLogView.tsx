"use client";

import { useState, useEffect } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AuditDetailDrawer } from "./AuditDetailDrawer";
import { AuditIntegrityBadge } from "./AuditIntegrityBadge";
import { AuditLogTable, type AuditEntry } from "./AuditLogTable";

interface AuditLogResponse {
    data: { entries: AuditEntry[]; total: number; page: number; pageSize: number };
}

export function AuditLogView() {
    const { tenantId } = useTenant();
    const [page, setPage] = useState(1);
    const [actorTypeFilter, setActorTypeFilter] = useState<string>("all");
    const [actionFilter, setActionFilter] = useState("");
    const [debouncedAction, setDebouncedAction] = useState("");
    const [dateFrom, setDateFrom] = useState("");
    const [dateTo, setDateTo] = useState("");
    const [selectedEntry, setSelectedEntry] = useState<AuditEntry | null>(null);

    useEffect(() => {
        const t = setTimeout(() => { setDebouncedAction(actionFilter); setPage(1); }, 300);
        return () => clearTimeout(t);
    }, [actionFilter]);

    const { data, isLoading, isError } = useQuery<AuditLogResponse>({
        queryKey: ["audit-log", tenantId, page, actorTypeFilter, debouncedAction, dateFrom, dateTo],
        queryFn: () => {
            const p = new URLSearchParams({ page: String(page), pageSize: "20" });
            if (actorTypeFilter && actorTypeFilter !== "all") p.set("actorType", actorTypeFilter);
            if (debouncedAction) p.set("action", debouncedAction);
            if (dateFrom) p.set("dateFrom", dateFrom);
            if (dateTo) p.set("dateTo", dateTo);
            return api.get<AuditLogResponse>(`/api/v1/audit-log?${p.toString()}`);
        },
        placeholderData: keepPreviousData,
    });

    const entries = data?.data?.entries ?? [];
    const total = data?.data?.total ?? 0;
    const pageSize = data?.data?.pageSize ?? 20;
    const totalPages = Math.ceil(total / pageSize);
    const hasFilters = !!(actorTypeFilter !== "all" || actionFilter || dateFrom || dateTo);

    const clearFilters = () => { setActorTypeFilter("all"); setActionFilter(""); setDateFrom(""); setDateTo(""); setPage(1); };

    if (isError) return (
        <Alert variant="destructive">
            <AlertCircle className="h-4 w-4"/>
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>Failed to load audit log.</AlertDescription>
        </Alert>
    );

    return (
        <div className="space-y-4">
            <AuditDetailDrawer entry={selectedEntry} open={!!selectedEntry} onClose={() => setSelectedEntry(null)}/>

            {/* Filter Bar */}
            <div className="flex flex-wrap items-center gap-4 bg-muted/20 p-4 rounded-lg">
                <div className="w-[180px]">
                    <Select value={actorTypeFilter} onValueChange={v => { setActorTypeFilter(v); setPage(1); }}>
                        <SelectTrigger><SelectValue placeholder="Actor Type"/></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Actors</SelectItem>
                            <SelectItem value="human">Human</SelectItem>
                            <SelectItem value="agent">Agent</SelectItem>
                            <SelectItem value="system">System</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div className="relative flex-1 min-w-[200px]">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"/>
                    <Input placeholder="Filter by action..." className="pl-9" value={actionFilter} onChange={e => setActionFilter(e.target.value)}/>
                </div>
                <div className="flex items-center gap-2">
                    <Input type="date" className="w-[150px]" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }}/>
                    <span className="text-muted-foreground text-sm">to</span>
                    <Input type="date" className="w-[150px]" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }}/>
                </div>
                <Button variant="ghost" size="sm" onClick={clearFilters} className="text-muted-foreground">
                    <X className="h-4 w-4 mr-2"/>Clear filters
                </Button>
                <div className="ml-auto"><AuditIntegrityBadge/></div>
            </div>

            <AuditLogTable entries={entries} isLoading={isLoading} hasFilters={hasFilters} onRowClick={setSelectedEntry}/>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between px-2">
                    <p className="text-sm text-muted-foreground">Page {page} of {totalPages}</p>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1 || isLoading}>Previous</Button>
                        <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages || isLoading}>Next</Button>
                    </div>
                </div>
            )}
        </div>
    );
}
