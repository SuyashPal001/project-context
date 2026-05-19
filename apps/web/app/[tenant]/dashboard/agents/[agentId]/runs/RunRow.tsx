"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import type { AgentRun } from "@/components/platform/agents/types";
import { statusConfig, formatDate, formatDuration } from "./_helpers";
import { RunDetailExpanded } from "./RunDetailExpanded";

interface RunRowProps {
    run: AgentRun;
    isExpanded: boolean;
    onToggle: () => void;
}

export function RunRow({ run, isExpanded, onToggle }: RunRowProps) {
    const cfg = statusConfig[run.status];

    return (
        <React.Fragment>
            <TableRow className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={onToggle}>
                <TableCell className="font-mono text-xs font-medium">
                    {run.id.slice(0, 8)}
                </TableCell>
                <TableCell className="text-sm">{run.trigger}</TableCell>
                <TableCell>
                    <Badge
                        variant="outline"
                        className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${cfg?.color ?? ""}`}
                    >
                        {cfg?.icon}
                        {run.status.replace("_", " ")}
                    </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{formatDate(run.startedAt)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{formatDate(run.completedAt)}</TableCell>
                <TableCell className="text-xs font-medium">
                    <span className="inline-flex items-center gap-1.5">
                        <Clock className="h-3 w-3 text-muted-foreground" />
                        {formatDuration(run.startedAt, run.completedAt)}
                    </span>
                </TableCell>
                <TableCell>
                    {isExpanded ? (
                        <ChevronUp className="h-4 w-4 text-muted-foreground" />
                    ) : (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    )}
                </TableCell>
            </TableRow>

            {isExpanded && (
                <TableRow className="bg-muted/50 hover:bg-muted/50 border-t-0">
                    <TableCell colSpan={7} className="py-8 px-8">
                        <RunDetailExpanded run={run} />
                    </TableCell>
                </TableRow>
            )}
        </React.Fragment>
    );
}
