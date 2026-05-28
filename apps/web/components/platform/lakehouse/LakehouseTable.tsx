"use client";

import { Database, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface PensionRecord {
    pension_id: string;
    pensioner_name: string;
    declared_amount: number;
    status: string;
    office_code: string;
    effective_date: string;
}

interface Props {
    records: PensionRecord[];
    version: number | null;
    loading: boolean;
}

const STATUS_STYLES: Record<string, string> = {
    original: "bg-zinc-800 text-zinc-300 border-zinc-700",
    corrected: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    verified: "bg-green-500/10 text-green-400 border-green-500/30",
    under_review: "bg-blue-500/10 text-blue-400 border-blue-500/30",
};

function formatAmount(n: number): string {
    return `₹${Number(n).toLocaleString("en-IN")}`;
}

export function LakehouseTable({ records, version, loading }: Props) {
    if (loading) {
        return (
            <div className="flex items-center justify-center py-20 text-zinc-500">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                <span className="text-sm">Reading snapshot…</span>
            </div>
        );
    }

    if (records.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-20 text-zinc-600">
                <Database className="w-8 h-8 mb-3 opacity-40" />
                <p className="text-sm">No records in this snapshot. Use Sync Cases to commit the latest pension cases.</p>
            </div>
        );
    }

    return (
        <div className="rounded-lg border border-zinc-800 overflow-hidden">
            <table className="w-full text-sm">
                <thead className="bg-zinc-900 border-b border-zinc-800">
                    <tr>
                        {["PPO / Pension ID", "Pensioner Name", "Declared Amount", "Status", "Office", "Effective Date"].map(h => (
                            <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-zinc-500 uppercase tracking-wider">
                                {h}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                    {records.map((r, i) => (
                        <tr key={r.pension_id ?? i} className="hover:bg-zinc-900/50 transition-colors">
                            <td className="px-4 py-3 font-mono text-xs text-blue-400">{r.pension_id}</td>
                            <td className="px-4 py-3 text-zinc-200 font-medium">{r.pensioner_name}</td>
                            <td className="px-4 py-3 font-mono text-zinc-200">{formatAmount(r.declared_amount)}</td>
                            <td className="px-4 py-3">
                                <Badge
                                    variant="outline"
                                    className={`text-xs capitalize ${STATUS_STYLES[r.status] ?? STATUS_STYLES.original}`}
                                >
                                    {r.status.replace(/_/g, ' ')}
                                </Badge>
                            </td>
                            <td className="px-4 py-3 font-mono text-xs text-zinc-400">{r.office_code}</td>
                            <td className="px-4 py-3 text-zinc-400 text-xs">{r.effective_date}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {version !== null && (
                <div className="bg-zinc-900/50 border-t border-zinc-800 px-4 py-2 flex items-center gap-2">
                    <span className="text-xs text-zinc-600 font-mono">delta version {version}</span>
                    <span className="text-zinc-700">·</span>
                    <span className="text-xs text-zinc-600">{records.length} records · immutable snapshot</span>
                </div>
            )}
        </div>
    );
}
