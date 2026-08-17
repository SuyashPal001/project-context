"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Copy } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { AuditEntryDetail } from "./AuditDetailDrawer";

export interface AuditEntry extends AuditEntryDetail {
    tenantId: string;
    metadata: Record<string, unknown> | null;
}

export function formatRelativeTime(dateString: string) {
    const date = new Date(dateString);
    const diffInSeconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (diffInSeconds < 60) return "just now";
    const m = Math.floor(diffInSeconds / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d ago`;
    return date.toLocaleDateString();
}

export const truncate = (str: string | null, length = 8) => {
    if (!str) return "—";
    return str.length <= length ? str : `${str.slice(0, length)}...`;
};

const actorColors: Record<string, string> = {
    human: "bg-blue-500/10 text-blue-500",
    agent: "bg-secondary text-muted-foreground",
    system: "bg-gray-500/10 text-gray-500",
};

interface Props {
    entries: AuditEntry[];
    isLoading: boolean;
    hasFilters: boolean;
    onRowClick: (entry: AuditEntry) => void;
}

export function AuditLogTable({ entries, isLoading, hasFilters, onRowClick }: Props) {
    const copy = (text: string, e: React.MouseEvent) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        toast.success("Trace ID copied");
    };

    return (
        <div className="rounded-md border border-border bg-card">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>Actor</TableHead>
                        <TableHead>Action</TableHead>
                        <TableHead>Resource</TableHead>
                        <TableHead>IP Address</TableHead>
                        <TableHead>Trace ID</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {isLoading && entries.length === 0 ? (
                        Array.from({ length: 5 }).map((_, i) => (
                            <TableRow key={i}>
                                {Array.from({ length: 6 }).map((_, j) => (
                                    <TableCell key={j}><Skeleton className="h-4 w-full"/></TableCell>
                                ))}
                            </TableRow>
                        ))
                    ) : entries.length > 0 ? (
                        entries.map(entry => (
                            <TableRow key={entry.id} className="hover:bg-muted/50 transition-colors cursor-pointer" onClick={() => onRowClick(entry)}>
                                <TableCell>
                                    <TooltipProvider>
                                        <Tooltip>
                                            <TooltipTrigger className="text-sm">{formatRelativeTime(entry.createdAt)}</TooltipTrigger>
                                            <TooltipContent>{new Date(entry.createdAt).toLocaleString()}</TooltipContent>
                                        </Tooltip>
                                    </TooltipProvider>
                                </TableCell>
                                <TableCell>
                                    <div className="flex items-center gap-2">
                                        <Badge variant="secondary" className={cn("text-[10px] font-bold uppercase tracking-wider", actorColors[entry.actorType])}>
                                            {entry.actorType}
                                        </Badge>
                                        <span className="text-xs text-muted-foreground font-mono">{truncate(entry.actorId)}</span>
                                    </div>
                                </TableCell>
                                <TableCell className="font-mono text-xs font-medium">{entry.action}</TableCell>
                                <TableCell>
                                    <div className="flex flex-col">
                                        <span className="text-sm font-medium">{entry.resource}</span>
                                        <span className="text-[10px] text-muted-foreground font-mono">{truncate(entry.resourceId)}</span>
                                    </div>
                                </TableCell>
                                <TableCell className="text-sm">{entry.ipAddress || "—"}</TableCell>
                                <TableCell>
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-muted-foreground font-mono">{truncate(entry.traceId, 8)}</span>
                                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={e => copy(entry.traceId, e)}>
                                            <Copy className="h-3 w-3"/>
                                        </Button>
                                    </div>
                                </TableCell>
                            </TableRow>
                        ))
                    ) : (
                        <TableRow>
                            <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                                {hasFilters ? "No audit entries found" : "No audit activity yet"}
                            </TableCell>
                        </TableRow>
                    )}
                </TableBody>
            </Table>
        </div>
    );
}
