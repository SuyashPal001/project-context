"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter, useParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, AlertTriangle, CheckCircle, Clock, ArrowUpCircle } from "lucide-react";

interface PensionCase {
    id: string;
    caseRef: string;
    pensionerName: string;
    status: "pending_review" | "cleared" | "incomplete" | "reviewed" | "escalated";
    assignedRole: string;
    createdAt: string;
}

const STATUS_CONFIG = {
    cleared:        { label: "Cleared", color: "bg-green-500/20 text-green-400 border-green-500/30", icon: CheckCircle },
    pending_review: { label: "Pending Review", color: "bg-amber-500/20 text-amber-400 border-amber-500/30", icon: AlertTriangle },
    incomplete:     { label: "Incomplete", color: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30", icon: Clock },
    reviewed:       { label: "Reviewed", color: "bg-blue-500/20 text-blue-400 border-blue-500/30", icon: CheckCircle },
    escalated:      { label: "Escalated", color: "bg-purple-500/20 text-purple-400 border-purple-500/30", icon: ArrowUpCircle },
};

async function fetchCases(): Promise<PensionCase[]> {
    const res = await fetch("/api/proxy/api/v1/pension/cases");
    if (!res.ok) return [];
    return res.json();
}

export default function PensionReviewPage() {
    const router = useRouter();
    const params = useParams();
    const tenant = params.tenant as string;

    const { data: cases = [], isLoading } = useQuery({
        queryKey: ["pension", "cases"],
        queryFn: fetchCases,
        refetchInterval: 15000,
    });

    const cleared = cases.filter(c => c.status === "cleared").length;
    const flagged = cases.filter(c => c.status === "pending_review").length;

    return (
        <div className="space-y-6">
            {/* Header */}
            <div>
                <h1 className="text-3xl font-bold tracking-tight text-foreground">
                    Pension Pre-Scrutiny Queue
                </h1>
                <p className="text-muted-foreground mt-2">
                    AI-PARAS · CCS Pension Rules 1972 · Automated pre-scrutiny results for officer review
                </p>
            </div>

            {/* Summary chips */}
            <div className="flex gap-4">
                <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-green-500/10 border border-green-500/20">
                    <CheckCircle className="w-4 h-4 text-green-400" />
                    <span className="text-sm text-green-400 font-medium">{cleared} Cleared</span>
                </div>
                <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                    <AlertTriangle className="w-4 h-4 text-amber-400" />
                    <span className="text-sm text-amber-400 font-medium">{flagged} Flagged</span>
                </div>
            </div>

            {/* Queue table */}
            <Card className="border-border bg-card">
                <CardHeader>
                    <CardTitle className="text-base font-semibold text-foreground flex items-center gap-2">
                        <FileText className="w-4 h-4 text-muted-foreground" />
                        Cases ({cases.length})
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    {isLoading ? (
                        <p className="text-muted-foreground text-sm py-8 text-center">Loading cases…</p>
                    ) : cases.length === 0 ? (
                        <p className="text-muted-foreground text-sm py-8 text-center">No pension cases found. Run the seed script to populate.</p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-border text-muted-foreground">
                                        <th className="text-left py-3 pr-4 font-medium">Case Ref</th>
                                        <th className="text-left py-3 pr-4 font-medium">Pensioner</th>
                                        <th className="text-left py-3 pr-4 font-medium">Status</th>
                                        <th className="text-left py-3 pr-4 font-medium">Assigned Role</th>
                                        <th className="text-left py-3 font-medium">Date</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {cases.map((c) => {
                                        const cfg = STATUS_CONFIG[c.status] ?? STATUS_CONFIG.pending_review;
                                        const Icon = cfg.icon;
                                        return (
                                            <tr
                                                key={c.id}
                                                className="border-b border-border/50 hover:bg-muted/30 cursor-pointer transition-colors"
                                                onClick={() => router.push(`/${tenant}/dashboard/pension-review/${c.id}`)}
                                            >
                                                <td className="py-3 pr-4 font-mono text-xs text-foreground">{c.caseRef}</td>
                                                <td className="py-3 pr-4 text-foreground">{c.pensionerName}</td>
                                                <td className="py-3 pr-4">
                                                    <Badge className={`${cfg.color} border text-xs gap-1`}>
                                                        <Icon className="w-3 h-3" />
                                                        {cfg.label}
                                                    </Badge>
                                                </td>
                                                <td className="py-3 pr-4 text-muted-foreground">{c.assignedRole}</td>
                                                <td className="py-3 text-muted-foreground text-xs">
                                                    {new Date(c.createdAt).toLocaleDateString('en-IN')}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
