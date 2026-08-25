import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { ingestDocument, isIngestibleDocument } from "@/lib/ingestDocument";
import { Attachment } from "@/types/agent-events";
import type { Asset } from "@/types/assets";

export interface PendingUpload {
    previewUrl?: string;
    name: string;
    type: string;
}

/** How many files a browser file-picker may hand over in one go, before any of
 *  them are uploaded. This is an upload-batch limit — it exists because each
 *  file is a separate presign + PUT. */
export const MAX_FILES_PER_SELECTION = 5;

/** How many attachments one message may carry. Files coming from Drive are
 *  already in S3, so none of the upload-batch reasoning applies to them: the
 *  real cost is context, not transfer. Kept separate because conflating the two
 *  is what made every real folder un-attachable. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;

// Pure — no React, no upload side effects — so the cap logic is directly
// testable without rendering the hook. `files: null` with no error means
// "user selected nothing," distinct from `error` meaning "selection rejected."
export function resolveFilesToUpload(
    fileList: FileList | null,
): { files: File[] | null; error: string | null } {
    if (!fileList || fileList.length === 0) return { files: null, error: null };
    if (fileList.length > MAX_FILES_PER_SELECTION) {
        return { files: null, error: `You can attach up to ${MAX_FILES_PER_SELECTION} files at once.` };
    }
    return { files: Array.from(fileList), error: null };
}

export function assetToAttachment(asset: Asset): Attachment {
    return {
        fileId: asset.fileId ?? asset.id,
        name: asset.filename,
        type: asset.mimeType ?? 'application/octet-stream',
        size: asset.size,
        previewUrl: asset.thumbnailUrl,
    };
}

const S3_PUT_MAX_ATTEMPTS = 3;

// Raw binary PUTs to S3 occasionally hit a transient network blip (dropped
// connection, momentary CORS/DNS hiccup) that a plain retry resolves — this
// showed up as an unreliable "sometimes an attached image just never
// appears" symptom, not a per-file-type bug. A definitive rejection (4xx —
// e.g. an expired/malformed presigned URL) won't succeed on retry, so only
// network-level failures and 5xx responses are retried.
async function putToS3WithRetry(uploadUrl: string, file: Blob, contentType: string, retryDelayMs: number): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= S3_PUT_MAX_ATTEMPTS; attempt++) {
        try {
            const response = await fetch(uploadUrl, {
                method: 'PUT',
                body: file,
                headers: { 'Content-Type': contentType }
            });
            if (response.ok || (response.status >= 400 && response.status < 500)) return response;
            lastError = new Error(`S3 responded ${response.status}`);
        } catch (err) {
            lastError = err;
        }
        if (attempt < S3_PUT_MAX_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
        }
    }
    throw lastError;
}

export async function uploadToS3(file: Blob, filename: string, contentType: string, size: number, retryDelayMs = 500) {
    // Storage defaults the S3 key to the raw filename when none is given, which
    // is correct for the Files/folder library (same name = intentional replace)
    // but wrong for chat attachments: two unrelated attachments sharing a name
    // would otherwise collide and overwrite each other. Always give chat
    // uploads a unique key so they never dedup against one another.
    const key = `chat-attachments/${crypto.randomUUID()}-${filename}`;
    const uploadRes = await api.post<{ data: { fileId: string; uploadUrl: string; key: string } }>(
        "/api/v1/files/upload",
        { filename, contentType, key }
    );
    const { fileId, uploadUrl } = uploadRes.data;

    let uploadResponse: Response;
    try {
        uploadResponse = await putToS3WithRetry(uploadUrl, file, contentType, retryDelayMs);
    } catch {
        throw new Error("Failed to upload to S3");
    }

    if (!uploadResponse.ok) throw new Error("Failed to upload to S3");

    // /confirm's response is the authoritative fileId, not the one /upload
    // issued: two uploads sharing a name collide on the same S3 key (storage
    // defaults the key to the raw filename), and the server dedups by
    // marking the newer upload's fileId deleted and pointing callers at the
    // pre-existing live file instead. Using the stale /upload fileId here
    // attaches a file reference that 404s on every later lookup.
    const confirmRes = await api.post<{ success: boolean; fileId: string }>(`/api/v1/files/${fileId}/confirm`, { size });
    return confirmRes.fileId ?? fileId;
}

export function useFileUpload() {
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const attachmentsRef = useRef(attachments);
    useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);

    useEffect(() => {
        return () => {
            attachmentsRef.current.forEach(att => {
                if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
            });
        };
    }, []);

    const removeAttachment = (fileId: string) => {
        setAttachments(prev => {
            const toRemove = prev.find(a => a.fileId === fileId);
            if (toRemove?.previewUrl) URL.revokeObjectURL(toRemove.previewUrl);
            return prev.filter(a => a.fileId !== fileId);
        });
    };

    const uploadFile = async (file: File) => {
        setIsUploading(true);
        const fileName = file.name;
        const fileType = file.type;
        const fileSize = file.size;

        const maxSize = fileType.startsWith('video/')
            ? 200 * 1024 * 1024
            : 35 * 1024 * 1024;

        if (fileSize > maxSize) {
            toast.error(`File too large. Maximum size is ${fileType.startsWith('video/') ? '200MB' : '35MB'}.`);
            setIsUploading(false);
            return;
        }

        let previewUrl: string | undefined;
        if (fileType.startsWith('image/')) {
            previewUrl = URL.createObjectURL(file);
        }
        setPendingUpload({ previewUrl, name: fileName, type: fileType });

        try {
            const fileId = await uploadToS3(file, fileName, fileType, fileSize);
            setAttachments(prev => [...prev, {
                fileId,
                name: fileName,
                type: fileType,
                size: fileSize,
                previewUrl,
            }]);

            // Documents additionally go through the ingestion pipeline so they
            // are chunked, embedded and retrievable in later conversations.
            // The /files upload above only stores the object; on its own it
            // leaves the document invisible to retrieve_documents.
            if (isIngestibleDocument(file)) {
                try {
                    const { duplicate } = await ingestDocument(file);
                    toast.success(duplicate
                        ? "Already in your knowledge base"
                        : "Added to your knowledge base");
                } catch (ingestError) {
                    // The attachment itself succeeded — the agent can still see
                    // it in this conversation, just not in future ones.
                    console.error("Knowledge base ingestion failed:", ingestError);
                    toast.warning("Attached, but could not add it to your knowledge base");
                }
            } else {
                toast.success("File uploaded successfully");
            }
        } catch (error) {
            console.error("Upload error:", error);
            toast.error("Failed to upload file");
            if (previewUrl) URL.revokeObjectURL(previewUrl);
        } finally {
            setIsUploading(false);
            setPendingUpload(null);
        }
    };

    const handleFileChange = async (
        e: React.ChangeEvent<HTMLInputElement>,
        fileInputRef: React.RefObject<HTMLInputElement | null>,
    ) => {
        const { files, error } = resolveFilesToUpload(e.target.files);
        if (error) {
            toast.error(error);
            if (fileInputRef.current) fileInputRef.current.value = "";
            return;
        }
        if (!files) return;
        // Sequential, not parallel: keeps upload state (isUploading/pendingUpload)
        // as the simple single-item shape it already is, and a failure partway
        // through still leaves the earlier files successfully attached.
        for (const file of files) {
            await uploadFile(file);
        }
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const uploadAudio = async (blob: Blob, previewUrl: string): Promise<Attachment> => {
        setIsUploading(true);
        try {
            const ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('mp4') ? 'mp4' : 'mp3';
            const fileId = await uploadToS3(blob, `audio_message_${Date.now()}.${ext}`, blob.type, blob.size);
            return {
                fileId,
                name: "Voice Message",
                type: blob.type,
                size: blob.size,
                previewUrl,
            };
        } finally {
            setIsUploading(false);
        }
    };

    const clearAttachments = () => {
        setAttachments([]);
        setPendingUpload(null);
    };

    const addAttachment = useCallback((asset: Asset) => {
        setAttachments(prev => prev.some(a => a.fileId === asset.fileId || a.fileId === asset.id)
            ? prev
            : [...prev, assetToAttachment(asset)]);
    }, []);

    // Drive files arrive already in Attachment shape — they have no sourceMessageId
    // to fake an Asset with. Same de-duplication as addAttachment.
    const addAttachments = useCallback((incoming: Attachment[]) => {
        setAttachments(prev => {
            const seen = new Set(prev.map(a => a.fileId));
            return [...prev, ...incoming.filter(a => a.fileId && !seen.has(a.fileId))];
        });
    }, []);

    return {
        attachments,
        pendingUpload,
        isUploading,
        removeAttachment,
        addAttachment,
        addAttachments,
        handleFileChange,
        uploadFile,
        uploadAudio,
        clearAttachments,
    };
}
