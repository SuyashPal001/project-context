import { CheckCircle2, PlayCircle, XCircle, Info } from "lucide-react";
import type { RunStatus } from "@/components/platform/agents/types";

export const statusConfig: Record<RunStatus, { color: string; icon: React.ReactNode }> = {
    completed: {
        color: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
        icon: <CheckCircle2 className="h-3 w-3" />,
    },
    running: {
        color: "bg-blue-500/10 text-blue-500 border-blue-500/20",
        icon: <PlayCircle className="h-3 w-3 animate-pulse" />,
    },
    failed: {
        color: "bg-red-500/10 text-red-500 border-red-500/20",
        icon: <XCircle className="h-3 w-3" />,
    },
    awaiting_approval: {
        color: "bg-amber-500/10 text-amber-500 border-amber-500/20",
        icon: <Info className="h-3 w-3" />,
    },
};

export function formatDuration(start: string, end: string | null): string {
    if (!end) return "—";
    const diffMs = new Date(end).getTime() - new Date(start).getTime();
    if (diffMs < 0) return "—";
    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

export function formatDate(dateStr: string | null): string {
    if (!dateStr) return "—";
    return new Date(dateStr).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    });
}
