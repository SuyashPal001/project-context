import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { FileRecord } from "../types";

export function useFileMutations() {
    const queryClient = useQueryClient();
    const [deletingFileId, setDeletingFileId] = useState<string | null>(null);
    const [deletingFolderName, setDeletingFolderName] = useState<string | null>(null);
    const [deletingFolder, setDeletingFolder] = useState(false);

    const deleteMutation = useMutation({
        mutationFn: async (fileId: string) => api.del(`/api/v1/files/${fileId}`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['files'] });
            toast.success("File deleted successfully");
            setDeletingFileId(null);
        },
        onError: () => {
            toast.error("Failed to delete file");
            setDeletingFileId(null);
        }
    });

    const deleteFolder = async (folderName: string, prefix: string, allFiles: FileRecord[]) => {
        const folderPrefix = `${prefix}${folderName}/`;
        const folderFiles = allFiles.filter(f => f.key.startsWith(folderPrefix));
        const total = folderFiles.length;
        setDeletingFolder(true);
        let failCount = 0;
        for (const file of folderFiles) {
            try { await api.del(`/api/v1/files/${file.id}`); } catch { failCount++; }
        }
        // Clean up the person folder record by identifier
        try {
            const lookup = await api.get<{ found: boolean; data?: { id: string } }>(`/api/v1/person-folders/lookup?identifier=${encodeURIComponent(folderName)}`);
            if (lookup.found && lookup.data?.id) {
                await api.del(`/api/v1/person-folders/${lookup.data.id}`);
            }
        } catch { /* person-folder record may not exist; not fatal to the delete */ }
        setDeletingFolder(false);
        setDeletingFolderName(null);
        queryClient.invalidateQueries({ queryKey: ['files'] });
        queryClient.invalidateQueries({ queryKey: ['person-folders'] });
        if (failCount > 0) {
            toast.error(`Deleted ${total - failCount} of ${total} files in "${folderName}" — ${failCount} failed`);
        } else {
            toast.success(`Folder "${folderName}" deleted`);
        }
    };

    const downloadFile = async (fileId: string) => {
        try {
            const res = await api.get<{ data: { downloadUrl: string } }>(`/api/v1/files/${fileId}/download`);
            window.open(res.data.downloadUrl, '_blank');
        } catch {
            toast.error("Failed to get download URL");
        }
    };

    return {
        deletingFileId, setDeletingFileId,
        deletingFolderName, setDeletingFolderName,
        deletingFolder,
        deleteMutation,
        deleteFolder,
        downloadFile,
    };
}
