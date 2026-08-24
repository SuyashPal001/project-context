import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { getFileCategory, isIngestibleCategory, isParseable } from "../fileCategory";
import type { FileRecord } from "../types";

async function ingestFileIds(fileIds: string[]): Promise<number> {
    let failCount = 0;
    for (const id of fileIds) {
        try {
            const res = await fetch(`/api/proxy/api/v1/files/${id}/ingest`, { method: 'POST' });
            if (!res.ok) failCount++;
        } catch {
            failCount++;
        }
    }
    return failCount;
}

function reportBatchResult(failCount: number, total: number, successMessage: string) {
    if (failCount > 0) {
        toast.error(`Failed to start ingestion for ${failCount} of ${total} file${total !== 1 ? 's' : ''}`);
    } else {
        toast.success(successMessage);
    }
}

export function useFileIngestion({ prefix, onPrefixChange }: { prefix: string; onPrefixChange: (prefix: string) => void }) {
    const queryClient = useQueryClient();
    const invalidateFiles = () => queryClient.invalidateQueries({ queryKey: ['files'] });

    const [ingestingFiles, setIngestingFiles] = useState<Set<string>>(new Set());
    const [ingestingFolders, setIngestingFolders] = useState<Set<string>>(new Set());
    const [isIngestingAllInFolder, setIsIngestingAllInFolder] = useState(false);

    const ingestFile = async (fileId: string) => {
        setIngestingFiles(prev => new Set(prev).add(fileId));
        try {
            const res = await fetch(`/api/proxy/api/v1/files/${fileId}/ingest`, { method: 'POST' });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || body.message || `Ingestion failed (HTTP ${res.status})`);
            }
            invalidateFiles();
        } catch (err: any) {
            toast.error(err.message || "Failed to start ingestion");
        } finally {
            setIngestingFiles(prev => { const n = new Set(prev); n.delete(fileId); return n; });
        }
    };

    // Triggered from the parent listing row: queues every un-done ingestible file
    // in the folder, then navigates in so the user sees per-file progress.
    const ingestFolder = async (folderName: string, allFiles: FileRecord[]) => {
        const folderPrefix = `${prefix}${folderName}/`;
        const pending = allFiles.filter(
            f => f.key.startsWith(folderPrefix) && f.ingestionStatus !== 'done'
                && isIngestibleCategory(getFileCategory(f.contentType, f.filename))
        );
        if (pending.length === 0) return;
        onPrefixChange(folderPrefix);
        setIngestingFolders(prev => new Set(prev).add(folderName));
        const failCount = await ingestFileIds(pending.map(f => f.id));
        setIngestingFolders(prev => { const n = new Set(prev); n.delete(folderName); return n; });
        invalidateFiles();
        reportBatchResult(failCount, pending.length, `Ingestion queued for folder "${folderName}"`);
    };

    // Triggered from inside a folder view ("Parse All"): queues every pending/failed
    // ingestible file the user is currently looking at.
    const ingestAllInFolder = async (filesInView: FileRecord[]) => {
        const pending = filesInView.filter(isParseable);
        if (pending.length === 0) return;
        setIsIngestingAllInFolder(true);
        const failCount = await ingestFileIds(pending.map(f => f.id));
        setIsIngestingAllInFolder(false);
        invalidateFiles();
        reportBatchResult(failCount, pending.length, `Parsing started for ${pending.length} file${pending.length !== 1 ? 's' : ''}`);
    };

    return {
        ingestingFiles,
        ingestingFolders,
        isIngestingAllInFolder,
        ingestFile,
        ingestFolder,
        ingestAllInFolder,
    };
}
