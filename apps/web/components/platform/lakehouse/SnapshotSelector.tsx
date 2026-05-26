"use client";

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck } from "lucide-react";

export interface Snapshot {
    version: number;
    label: string;
    description: string;
    committed_at: string;
    operation: string;
}

interface Props {
    snapshots: Snapshot[];
    selectedVersion: number | null;
    onSelect: (version: number) => void;
}

function formatTs(iso: string): string {
    if (!iso) return "—";
    try {
        return new Date(iso).toLocaleString("en-IN", {
            day: "2-digit", month: "short", year: "numeric",
            hour: "2-digit", minute: "2-digit",
        });
    } catch {
        return iso;
    }
}

export function SnapshotSelector({ snapshots, selectedVersion, onSelect }: Props) {
    return (
        <div className="flex items-center gap-3">
            <Select
                value={selectedVersion !== null ? String(selectedVersion) : ""}
                onValueChange={(v) => onSelect(Number(v))}
            >
                <SelectTrigger className="w-[340px] bg-zinc-900 border-zinc-800 font-mono text-sm">
                    <SelectValue placeholder="Select snapshot…" />
                </SelectTrigger>
                <SelectContent className="bg-zinc-900 border-zinc-800">
                    {snapshots.map((s) => (
                        <SelectItem
                            key={s.version}
                            value={String(s.version)}
                            className="font-mono text-sm"
                        >
                            <span className="text-zinc-400 mr-2">v{s.version}</span>
                            <span className="text-zinc-200">{s.label}</span>
                            {s.committed_at && (
                                <span className="text-zinc-500 ml-2 text-xs">{formatTs(s.committed_at)}</span>
                            )}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>

            <Badge
                variant="outline"
                className="gap-1.5 border-green-500/30 text-green-400 bg-green-500/10 text-xs"
            >
                <ShieldCheck className="w-3 h-3" />
                ACID Guaranteed
            </Badge>
        </div>
    );
}
