"use client";

import React, { useState, useRef } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface ImageUploadProps {
    value: string;
    onChange: (url: string) => void;
    onFileIdChange?: (fileId: string) => void;
    fallbackText: string;
    disabled?: boolean;
}

export function ImageUpload({ value, onChange, onFileIdChange, fallbackText, disabled }: ImageUploadProps) {
    const [isUploading, setIsUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        // Basic validation
        if (!file.type.startsWith('image/')) {
            toast.error("Please select an image file");
            return;
        }

        setIsUploading(true);
        try {
            // 1. Get presigned URL
            // @ts-ignore - response shape from API
            const { data } = await api.post<{ data: { fileId: string; uploadUrl: string } }>('/api/v1/files/upload', {
                filename: file.name,
                contentType: file.type,
                size: file.size,
            });

            // 2. Upload to S3 (raw fetch to avoid JSON headers)
            const uploadRes = await fetch(data.uploadUrl, {
                method: 'PUT',
                body: file,
                headers: {
                    'Content-Type': file.type,
                },
            });

            if (!uploadRes.ok) throw new Error('Failed to upload to S3');

            // 3. Confirm upload — the response's fileId is authoritative, not the
            // upload response's: if the S3 key collides with an already-uploaded
            // file, /confirm dedupes by discarding this pending record and
            // returning the existing file's id instead. Using data.fileId past
            // this point would fetch a presigned URL for a file that was just
            // soft-deleted.
            const { fileId: confirmedFileId } = await api.post<{ success: boolean; fileId: string }>(
                `/api/v1/files/${data.fileId}/confirm`, { size: file.size }
            );

            // 4. Get signed display URL
            const { presignedUrl } = await api.get<{ presignedUrl: string }>(
                `/api/v1/files/${confirmedFileId}/presigned-url`
            );

            onChange(presignedUrl);
            if (onFileIdChange) onFileIdChange(confirmedFileId);
            
            toast.success("Image uploaded successfully");
        } catch (error: any) {
            console.error('Upload error:', error);
            toast.error(error.message || "Failed to upload image");
        } finally {
            setIsUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-4">
                <div className="h-20 w-20 shrink-0 rounded-full overflow-hidden bg-muted border-2 border-border flex items-center justify-center relative">
                    {value ? (
                        <img src={value} alt="" className="h-full w-full object-cover" />
                    ) : (
                        <div className="text-xl font-bold text-muted-foreground uppercase">
                            {fallbackText.slice(0, 2)}
                        </div>
                    )}
                    {isUploading && (
                        <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                            <Loader2 className="h-6 w-6 animate-spin text-white" />
                        </div>
                    )}
                </div>
                <div className="flex flex-col gap-2">
                    <input
                        type="file"
                        ref={fileInputRef}
                        className="hidden"
                        accept="image/*"
                        onChange={handleFileChange}
                        disabled={disabled || isUploading}
                    />
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={disabled || isUploading}
                        onClick={() => fileInputRef.current?.click()}
                    >
                        {isUploading ? "Uploading..." : "Upload image"}
                    </Button>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                        Square images recommended
                    </p>
                </div>
            </div>
        </div>
    );
}
