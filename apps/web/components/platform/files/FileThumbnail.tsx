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
export function FileThumbnail({ fileId, alt, fallbackToLibraryAsset, anchorTop }: {
    fileId: string;
    alt: string;
    // When true, a 404 on the tenant files lookup retries against
    // creative_library_assets — the id can be either one (e.g. a clarifying-
    // question option pointing at a platform library preset rather than a
    // generated file). Same fallback idea as the orchestrator's mediaCache.
    // Off by default so existing Drive/grid callers (always real file ids)
    // don't pay for a second request on every genuine miss.
    fallbackToLibraryAsset?: boolean;
    // People (avatars) crop from the top, so a tall portrait loses its feet, never its face.
    anchorTop?: boolean;
}) {
    const { data, isError } = useQuery({
        queryKey: ['file-download-url', fileId, fallbackToLibraryAsset ?? false],
        queryFn: async () => {
            try {
                const res = await api.get<{ data: { downloadUrl: string } }>(`/api/v1/files/${fileId}/download`);
                return res.data.downloadUrl;
            } catch (err) {
                if (!fallbackToLibraryAsset || (err as { status?: number }).status !== 404) throw err;
                const res = await api.get<{ presignedUrl: string }>(`/api/v1/creative-library-assets/${fileId}/presigned-url`);
                return res.presignedUrl;
            }
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
    return <img src={data} alt={alt} className={anchorTop ? "w-full h-full object-cover object-top" : "w-full h-full object-cover"} />;
}
