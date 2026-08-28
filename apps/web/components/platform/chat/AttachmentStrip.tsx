import { X, Loader2 } from "lucide-react";
import { Attachment } from "@/types/agent-events";
import { assetTypeForFile } from "@/lib/assetType";
import { TYPE_ICONS, TYPE_BADGES, TYPE_STYLES } from "@/components/platform/canvas/assetTypeStyles";
import { useVideoFrameThumbnail } from "@/components/platform/canvas/videoFrameThumbnail";
import { useThumbnailUrl } from "@/hooks/useAssetThumbnail";
import { PendingUpload } from "./useFileUpload";

// One 80x80 tile. Shares the classifier and the tint/icon/badge maps with the
// canvas gallery and the Drive grid, so an attachment looks the same in the
// composer as it does everywhere else it is listed — previously this fork knew
// only "video or not", and every mp3, pdf and csv rendered as the same grey
// document.
function AttachmentTile({ fileId, name, type, previewUrl }: { fileId?: string; name: string; type: string; previewUrl?: string }) {
    const assetType = assetTypeForFile(type, name);
    const Icon = TYPE_ICONS[assetType];
    const typeStyle = TYPE_STYLES[assetType];

    // `previewUrl` only ever arrives for a fresh local upload (a blob: URL).
    // A file attached by reference (Drive / the "#" picker) has a fileId but
    // no previewUrl, and previously fell straight to the icon regardless of
    // type — fetch the same real thumbnail the "#" picker itself shows,
    // through the same rate-limit-safe shared hook (small fixed list here,
    // so no lazy in-view gating needed — just `enabled`).
    const isImage = assetType === 'image';
    const isVideo = assetType === 'video';
    const fetchedImageUrl = useThumbnailUrl(fileId ?? '', !previewUrl && isImage && !!fileId);
    const fetchedVideoUrl = useVideoFrameThumbnail(fileId ?? '', !previewUrl && isVideo && !!fileId);
    const resolvedUrl = previewUrl ?? fetchedImageUrl ?? fetchedVideoUrl;

    return (
        <div className={`relative h-20 w-20 rounded-xl overflow-hidden border border-border/40 shadow-sm ${typeStyle.bg}`}>
            {resolvedUrl ? (
                <img src={resolvedUrl} alt={name} className="h-full w-full object-cover" />
            ) : (
                <div className="h-full w-full flex flex-col items-center justify-center gap-1 p-2">
                    <Icon className={`h-7 w-7 ${typeStyle.icon}`} />
                    <span className="text-[9px] font-medium line-clamp-2 text-center break-all leading-tight">{name}</span>
                </div>
            )}
            <span className="absolute top-1 left-1 text-[8px] font-bold px-1 py-0.5 rounded bg-background/90 border border-border/60">
                {TYPE_BADGES[assetType]}
            </span>
        </div>
    );
}

interface AttachmentStripProps {
    attachments: Attachment[];
    pendingUpload: PendingUpload | null;
    onRemove: (fileId: string) => void;
}

export function AttachmentStrip({ attachments, pendingUpload, onRemove }: AttachmentStripProps) {
    if (attachments.length === 0 && !pendingUpload) return null;

    return (
        <div className="flex flex-wrap gap-3 p-3 pb-2 animate-in fade-in slide-in-from-top-2 duration-300 w-full">
            {attachments.map((file) => (
                <div key={file.fileId} className="relative">
                    <AttachmentTile fileId={file.fileId} name={file.name} type={file.type} previewUrl={file.previewUrl} />
                    <button
                        onClick={() => onRemove(file.fileId)}
                        className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-foreground text-background flex items-center justify-center shadow-md hover:scale-110 transition-transform duration-150"
                    >
                        <X className="h-3 w-3" />
                    </button>
                </div>
            ))}

            {pendingUpload && (
                <div className="relative">
                    {/* Same tile as a settled attachment, dimmed under the upload
                        overlay — so a file's type is legible while it uploads,
                        not only once it lands. */}
                    <div className="opacity-50">
                        <AttachmentTile name={pendingUpload.name} type={pendingUpload.type} previewUrl={pendingUpload.previewUrl} />
                    </div>
                    <div className="absolute inset-0 rounded-xl overflow-hidden">
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
                        <div className="absolute inset-0 bg-black/30 animate-pulse" />
                        <div className="absolute inset-0 flex items-center justify-center">
                            <Loader2 className="h-5 w-5 text-white animate-spin drop-shadow" />
                        </div>
                    </div>
                </div>
            )}

            <div className="w-full h-px bg-border/40 mt-1" />
        </div>
    );
}
