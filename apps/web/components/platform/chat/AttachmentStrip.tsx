import { X, FileText, Video, Loader2 } from "lucide-react";
import { Attachment } from "@/types/agent-events";
import { PendingUpload } from "./useFileUpload";

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
                    {file.previewUrl ? (
                        <div className="h-20 w-20 rounded-xl overflow-hidden border border-border/40 shadow-sm">
                            <img
                                src={file.previewUrl}
                                alt={file.name}
                                className="h-full w-full object-cover"
                            />
                        </div>
                    ) : (
                        <div className="h-20 w-20 rounded-xl border border-border/40 bg-muted flex flex-col items-center justify-center gap-1 p-2">
                            {file.type.startsWith('video/') ? (
                                <Video className="h-7 w-7 text-muted-foreground opacity-80" />
                            ) : (
                                <FileText className="h-7 w-7 text-muted-foreground opacity-80" />
                            )}
                            <span className="text-[9px] font-medium line-clamp-2 text-center break-all leading-tight">{file.name}</span>
                        </div>
                    )}
                    <button
                        onClick={() => onRemove(file.fileId)}
                        className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-foreground text-background flex items-center justify-center shadow-md hover:scale-110 transition-transform duration-150"
                    >
                        <X className="h-3 w-3" />
                    </button>
                </div>
            ))}

            {pendingUpload && (
                <div className="relative h-20 w-20 rounded-xl overflow-hidden border border-border/40 shadow-sm">
                    {pendingUpload.previewUrl ? (
                        <img
                            src={pendingUpload.previewUrl}
                            alt="Uploading..."
                            className="h-full w-full object-cover opacity-50"
                        />
                    ) : (
                        <div className="h-full w-full bg-muted" />
                    )}
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
                    <div className="absolute inset-0 bg-black/30 animate-pulse" />
                    <div className="absolute inset-0 flex items-center justify-center">
                        <Loader2 className="h-5 w-5 text-white animate-spin drop-shadow" />
                    </div>
                </div>
            )}

            <div className="w-full h-px bg-border/40 mt-1" />
        </div>
    );
}
