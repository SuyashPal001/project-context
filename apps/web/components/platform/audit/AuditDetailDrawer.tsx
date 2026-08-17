"use client";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface AuditEntryDetail {
    id: string;
    actorId: string;
    actorType: "human" | "agent" | "system";
    action: string;
    resource: string;
    resourceId: string | null;
    ipAddress: string | null;
    traceId: string;
    createdAt: string;
    previousState: Record<string, unknown> | null;
    newState: Record<string, unknown> | null;
    prevHash: string | null;
    entryHash: string | null;
}

interface Props {
    entry: AuditEntryDetail | null;
    open: boolean;
    onClose: () => void;
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
    if (value == null) {
        return (
            <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
                <p className="text-xs text-muted-foreground italic">none</p>
            </div>
        );
    }
    return (
        <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
            <pre className="text-xs bg-muted/30 rounded-md p-3 overflow-auto max-h-48 font-mono whitespace-pre-wrap break-all">
                {JSON.stringify(value, null, 2)}
            </pre>
        </div>
    );
}

function HashLine({ label, value }: { label: string; value: string | null }) {
    return (
        <div className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</span>
            <span className="text-xs font-mono text-foreground/70 break-all">
                {value ?? <span className="italic text-muted-foreground">none (pre-chain entry)</span>}
            </span>
        </div>
    );
}

export function AuditDetailDrawer({ entry, open, onClose }: Props) {
    if (!entry) return null;

    const actorColors: Record<string, string> = {
        human: "bg-blue-500/10 text-blue-500",
        agent: "bg-secondary text-muted-foreground",
        system: "bg-gray-500/10 text-gray-500",
    };

    return (
        <Sheet open={open} onOpenChange={v => !v && onClose()}>
            <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
                <SheetHeader className="space-y-1">
                    <SheetTitle className="font-mono text-base">{entry.action}</SheetTitle>
                    <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="secondary" className={cn("text-[10px] font-bold uppercase tracking-wider", actorColors[entry.actorType])}>
                            {entry.actorType}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{entry.resource}</span>
                        <span className="text-xs text-muted-foreground">{new Date(entry.createdAt).toLocaleString()}</span>
                    </div>
                </SheetHeader>

                <div className="mt-6 space-y-5">
                    <div className="grid grid-cols-2 gap-3 text-xs">
                        <div><span className="text-muted-foreground">Actor ID</span><p className="font-mono break-all">{entry.actorId}</p></div>
                        <div><span className="text-muted-foreground">Resource ID</span><p className="font-mono break-all">{entry.resourceId ?? "—"}</p></div>
                        <div><span className="text-muted-foreground">IP Address</span><p>{entry.ipAddress ?? "—"}</p></div>
                        <div><span className="text-muted-foreground">Trace ID</span><p className="font-mono break-all">{entry.traceId || "—"}</p></div>
                    </div>

                    <hr className="border-border"/>

                    <JsonBlock label="Before" value={entry.previousState}/>
                    <JsonBlock label="After" value={entry.newState}/>

                    <hr className="border-border"/>

                    <div className="space-y-2">
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Chain integrity</p>
                        <HashLine label="prev hash" value={entry.prevHash}/>
                        <HashLine label="entry hash" value={entry.entryHash}/>
                        <p className="text-[10px] text-muted-foreground pt-1">
                            Entry ID: <span className="font-mono">{entry.id}</span>
                        </p>
                    </div>
                </div>
            </SheetContent>
        </Sheet>
    );
}
