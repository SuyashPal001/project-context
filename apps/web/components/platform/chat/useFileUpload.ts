import { useState, useEffect } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Attachment } from "@/types/agent-events";

export interface PendingUpload {
    previewUrl?: string;
    name: string;
    type: string;
}

async function uploadToS3(file: Blob, filename: string, contentType: string, size: number) {
    const uploadRes = await api.post<{ data: { fileId: string; uploadUrl: string; key: string } }>(
        "/api/v1/files/upload",
        { filename, contentType }
    );
    const { fileId, uploadUrl } = uploadRes.data;
    console.log('[upload] uploadUrl:', uploadUrl);
    console.log('[upload] fileId:', fileId);

    console.log('[upload] starting S3 PUT');
    const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': contentType }
    });
    console.log('[upload] S3 PUT status:', uploadResponse.status);

    if (!uploadResponse.ok) throw new Error("Failed to upload to S3");

    await api.post(`/api/v1/files/${fileId}/confirm`, { size });
    return fileId;
}

export function useFileUpload() {
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null);
    const [isUploading, setIsUploading] = useState(false);

    useEffect(() => {
        return () => {
            attachments.forEach(attachment => {
                if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
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

    const handleFileChange = async (
        e: React.ChangeEvent<HTMLInputElement>,
        fileInputRef: React.RefObject<HTMLInputElement | null>,
    ) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setIsUploading(true);
        const fileName = file.name;
        const fileType = file.type;
        const fileSize = file.size;

        const maxSize = fileType.startsWith('video/')
            ? 200 * 1024 * 1024
            : 35 * 1024 * 1024;

        if (fileSize > maxSize) {
            toast.error(`File too large. Maximum size is ${fileType.startsWith('video/') ? '200MB' : '35MB'}.`);
            if (fileInputRef.current) fileInputRef.current.value = "";
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
            toast.success("File uploaded successfully");
        } catch (error) {
            console.error("Upload error:", error);
            toast.error("Failed to upload file");
            if (previewUrl) URL.revokeObjectURL(previewUrl);
        } finally {
            setIsUploading(false);
            setPendingUpload(null);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
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

    return {
        attachments,
        pendingUpload,
        isUploading,
        removeAttachment,
        handleFileChange,
        uploadAudio,
        clearAttachments,
    };
}
