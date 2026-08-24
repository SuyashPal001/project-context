"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ImageIcon } from "lucide-react";

// Grid-view thumbnail for image files. Resolves a presigned download URL
// (same /files/:id/download route the table's download action uses) through
// useQuery so paging back to an already-seen page reuses the cached URL
// instead of re-fetching it — it's valid for a full hour (see
// storageService.getDownloadUrl's default expiresIn), plenty of headroom
// for a single grid session.
export function FileThumbnail({ fileId, alt }: { fileId: string; alt: string }) {
    const { data, isError } = useQuery({
        queryKey: ['file-download-url', fileId],
        queryFn: async () => {
            const res = await api.get<{ data: { downloadUrl: string } }>(`/api/v1/files/${fileId}/download`);
            return res.data.downloadUrl;
        },
        staleTime: 30 * 60 * 1000,
    });

    if (isError) {
        return (
            <div className="w-full h-full flex items-center justify-center bg-muted/30">
                <ImageIcon className="w-6 h-6 text-muted-foreground/40" />
            </div>
        );
    }

    if (!data) {
        return <div className="w-full h-full bg-muted/30 animate-pulse" />;
    }

    // eslint-disable-next-line @next/next/no-img-element -- presigned S3 URL, not a local asset next/image can optimize
    return <img src={data} alt={alt} className="w-full h-full object-cover" />;
}
