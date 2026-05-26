"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PermissionGate } from "@/components/platform/PermissionGate";
import { SnapshotSelector, type Snapshot } from "@/components/platform/lakehouse/SnapshotSelector";
import { LakehouseTable, type PensionRecord } from "@/components/platform/lakehouse/LakehouseTable";
import { CommitModal } from "@/components/platform/lakehouse/CommitModal";
import { Button } from "@/components/ui/button";
import { usePermissions } from "@/lib/hooks/usePermissions";
import { GitCommitHorizontal } from "lucide-react";

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
                        <Button
                            onClick={() => setIsCorrectOpen(true)}
                            disabled={!recordsData?.records?.length}
                            variant="outline"
                            className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                        >
                            <GitCommitHorizontal className="w-4 h-4 mr-2" />
                            Commit Correction
                        </Button>
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
