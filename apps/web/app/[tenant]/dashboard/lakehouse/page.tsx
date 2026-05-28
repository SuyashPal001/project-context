"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PermissionGate } from "@/components/platform/PermissionGate";
import { SnapshotSelector, type Snapshot } from "@/components/platform/lakehouse/SnapshotSelector";
import { LakehouseTable, type PensionRecord } from "@/components/platform/lakehouse/LakehouseTable";
import { CommitModal } from "@/components/platform/lakehouse/CommitModal";
import { Button } from "@/components/ui/button";
import { usePermissions } from "@/lib/hooks/usePermissions";
import { GitCommitHorizontal, RefreshCw } from "lucide-react";

async function fetchSnapshots(): Promise<Snapshot[]> {
    const res = await fetch("/api/proxy/api/v1/lakehouse/snapshots");
    if (!res.ok) return [];
    const data = await res.json();
    return data.snapshots ?? [];
}

async function fetchRecords(version: number | null): Promise<{ records: PensionRecord[]; version: number }> {
    const url = version !== null
        ? `/api/proxy/api/v1/lakehouse/records?version=${version}`
        : `/api/proxy/api/v1/lakehouse/records`;
    const res = await fetch(url);
    if (!res.ok) return { records: [], version: 0 };
    return res.json();
}

export default function LakehousePage() {
    const { can } = usePermissions();
    const queryClient = useQueryClient();
    const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
    const [isCorrectOpen, setIsCorrectOpen] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);

    const handleSync = async () => {
        setIsSyncing(true);
        try {
            const casesRes = await fetch("/api/proxy/api/v1/pension/cases");
            if (!casesRes.ok) return;
            const cases = await casesRes.json() as Array<{
                caseRef: string;
                pensionerName: string;
                officeCode: string;
                status: string;
                fields: Record<string, unknown>;
                createdAt: string;
            }>;
            if (!cases.length) return;

            const records = cases.map(c => ({
                pension_id: c.caseRef,
                pensioner_name: c.pensionerName,
                declared_amount: Number(c.fields?.declared_pension ?? c.fields?.last_pay ?? 0),
                status: c.status,
                office_code: c.officeCode ?? "PB-001",
                effective_date: c.createdAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
            }));

            const commitRes = await fetch("/api/proxy/api/v1/lakehouse/commit", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    records,
                    label: `Sync — ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`,
                }),
            });
            if (!commitRes.ok) return;
            const { version } = await commitRes.json();
            queryClient.invalidateQueries({ queryKey: ["lakehouse"] });
            setSelectedVersion(version);
        } finally {
            setIsSyncing(false);
        }
    };

    const { data: snapshots = [], isLoading: snapshotsLoading } = useQuery({
        queryKey: ["lakehouse", "snapshots"],
        queryFn: fetchSnapshots,
        refetchInterval: 10000,
    });

    const { data: recordsData, isLoading: recordsLoading } = useQuery({
        queryKey: ["lakehouse", "records", selectedVersion],
        queryFn: () => fetchRecords(selectedVersion),
    });

    const handleVersionSelect = (version: number) => {
        setSelectedVersion(version);
    };

    const handleCorrectionSuccess = (newVersion: number) => {
        queryClient.invalidateQueries({ queryKey: ["lakehouse"] });
        setSelectedVersion(newVersion);
    };

    return (
        <PermissionGate resource="files" action="read">
            <div className="space-y-6">
                {/* Header */}
                <div className="flex justify-between items-start">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-foreground">
                            Document Lakehouse
                        </h1>
                        <p className="text-muted-foreground mt-2">
                            Delta Lake — ACID transactions · Immutable snapshots · Time-travel audit queries
                        </p>
                    </div>
                    {can("files", "create") && (
                        <div className="flex gap-2">
                            <Button
                                onClick={handleSync}
                                disabled={isSyncing}
                                variant="outline"
                                className="border-zinc-600 text-zinc-300 hover:bg-zinc-800"
                            >
                                <RefreshCw className={`w-4 h-4 mr-2 ${isSyncing ? "animate-spin" : ""}`} />
                                {isSyncing ? "Syncing…" : "Sync Cases"}
                            </Button>
                            <Button
                                onClick={() => setIsCorrectOpen(true)}
                                disabled={!recordsData?.records?.length}
                                variant="outline"
                                className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                            >
                                <GitCommitHorizontal className="w-4 h-4 mr-2" />
                                Commit Correction
                            </Button>
                        </div>
                    )}
                </div>

                {/* Time-travel controls */}
                <div className="flex items-center gap-4 p-4 rounded-lg border border-zinc-800 bg-zinc-950">
                    <span className="text-sm text-zinc-500 shrink-0">Viewing snapshot:</span>
                    {snapshotsLoading ? (
                        <span className="text-sm text-zinc-600">Loading snapshots…</span>
                    ) : snapshots.length === 0 ? (
                        <span className="text-sm text-zinc-600">No snapshots yet — ingest a document to create one</span>
                    ) : (
                        <SnapshotSelector
                            snapshots={snapshots}
                            selectedVersion={selectedVersion ?? snapshots[0]?.version ?? null}
                            onSelect={handleVersionSelect}
                        />
                    )}
                </div>

                {/* Records table */}
                <LakehouseTable
                    records={recordsData?.records ?? []}
                    version={recordsData?.version ?? null}
                    loading={recordsLoading}
                />

                {/* Correction modal */}
                <CommitModal
                    open={isCorrectOpen}
                    onOpenChange={setIsCorrectOpen}
                    records={recordsData?.records ?? []}
                    onSuccess={handleCorrectionSuccess}
                />
            </div>
        </PermissionGate>
    );
}
