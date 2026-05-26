"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UploadCloud, File, X, CheckCircle2, Loader2 } from "lucide-react";

interface UploadFileModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    currentPrefix: string;
    onSuccess: () => void;
}

function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function uploadToS3(url: string, file: globalThis.File, onProgress: (pct: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                onProgress(Math.round((e.loaded / e.total) * 100));
            }
        };
        
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve();
            } else {
                reject(new Error(`Upload failed: ${xhr.status}`));
            }
        };
        
        xhr.onerror = () => reject(new Error('Upload failed'));
        
        xhr.open('PUT', url);
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.send(file);
    });
}

export function UploadFileModal({ open, onOpenChange, currentPrefix, onSuccess }: UploadFileModalProps) {
    const [selectedFile, setSelectedFile] = useState<globalThis.File | null>(null);
    const [customPrefix, setCustomPrefix] = useState(currentPrefix);
    const [isDragActive, setIsDragActive] = useState(false);
    
    // Status states
    const [uploading, setUploading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [uploadComplete, setUploadComplete] = useState(false);
    const [error, setError] = useState<string | null>(null);
    
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleClose = () => {
        if (uploading) return;
        onOpenChange(false);
        setTimeout(() => {
            setSelectedFile(null);
            setCustomPrefix(currentPrefix);
            setUploading(false);
            setProgress(0);
            setUploadComplete(false);
            setError(null);
        }, 300);
    };

    useEffect(() => {
        if (open && !selectedFile && !uploading && !uploadComplete) {
            setCustomPrefix(currentPrefix);
        }
    }, [open, currentPrefix, selectedFile, uploading, uploadComplete]);

    const handleDrag = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "dragenter" || e.type === "dragover") {
            setIsDragActive(true);
        } else if (e.type === "dragleave") {
            setIsDragActive(false);
        }
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragActive(false);
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            setSelectedFile(e.dataTransfer.files[0]);
            setError(null);
        }
    }, []);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setSelectedFile(e.target.files[0]);
            setError(null);
        }
    };

    async function handleUpload() {
        if (!selectedFile) return;
        
        setUploading(true);
        setProgress(0);
        setError(null);
        
        try {
            const formattedPrefix = customPrefix ? (customPrefix.endsWith('/') ? customPrefix : `${customPrefix}/`) : '';
            const keyPath = `${formattedPrefix}${selectedFile.name}`;

            const res = await fetch('/api/proxy/api/v1/files/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filename: selectedFile.name,
                    contentType: selectedFile.type || 'application/octet-stream',
                    key: keyPath
                }),
            });
            
            if (!res.ok) {
                const errData = await res.json().catch(() => null);
                throw new Error(errData?.error || 'Failed to get upload URL');
            }
            
            const { data } = await res.json();

            await uploadToS3(data.uploadUrl, selectedFile, (pct) => setProgress(pct));

            // Confirm upload so the DB record moves from pending → uploaded
            await fetch(`/api/proxy/api/v1/files/${data.fileId}/confirm`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ size: selectedFile.size }),
            });

            // Trigger ingestion (fire and don't await — status shown in table)
            fetch(`/api/proxy/api/v1/files/${data.fileId}/ingest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            }).catch(() => {});

            // Refresh table after ingestion completes (typically 4–8 seconds)
            setTimeout(() => onSuccess(), 5000);

            setUploadComplete(true);
            onSuccess();
        } catch (err: any) {
            setError(err.message || 'An unexpected error occurred during upload.');
        } finally {
            setUploading(false);
        }
    }

    if (uploadComplete) {
        return (
            <Dialog open={open} onOpenChange={handleClose}>
                <DialogContent className="sm:max-w-md bg-zinc-950 border-zinc-800 flex flex-col items-center justify-center p-8">
                    <div className="h-16 w-16 bg-green-500/10 rounded-full flex items-center justify-center mb-6">
                        <CheckCircle2 className="h-8 w-8 text-green-500" />
                    </div>
                    <DialogTitle className="text-xl font-semibold">Upload Complete</DialogTitle>
                    <DialogDescription className="text-center mt-2 mb-6">
                        <span className="font-medium text-zinc-300">{selectedFile?.name}</span> uploaded and ingestion started. Check the Document Ingestion table for processing status.
                    </DialogDescription>
                    <Button onClick={handleClose} className="w-full">Done</Button>
                </DialogContent>
            </Dialog>
        );
    }

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="sm:max-w-md bg-zinc-950 border-zinc-800 overflow-hidden">
                <DialogHeader>
                    <DialogTitle>Upload File</DialogTitle>
                    <DialogDescription>
                        {uploading ? "Transferring payload chunks directly into isolated S3 containers." : "Select a payload asset to securely integrate within your workspace bounds."}
                    </DialogDescription>
                </DialogHeader>

                <div className="py-4 space-y-6">
                    {uploading ? (
                        <div className="space-y-4 py-8">
                            <div className="flex justify-between text-sm font-medium">
                                <span className="text-zinc-200 truncate pr-4 text-xs font-mono">{selectedFile?.name}</span>
                                <span className="text-primary">{progress}%</span>
                            </div>
                            <div className="h-2 w-full bg-zinc-800 rounded-full overflow-hidden border border-zinc-700/50">
                                <div 
                                    className="h-full bg-primary transition-all duration-300 ease-out"
                                    style={{ width: `${progress}%` }}
                                />
                            </div>
                            <p className="text-xs text-zinc-500 text-center uppercase tracking-widest mt-4">Transacting HTTP streams natively</p>
                        </div>
                    ) : (
                        <>
                            <div className="space-y-2">
                                <Label htmlFor="folder-path" className="text-zinc-400 text-xs uppercase tracking-wide">Insertion Path (S3 Key Prefix)</Label>
                                <Input 
                                    id="folder-path" 
                                    disabled={uploading}
                                    value={customPrefix}
                                    onChange={(e) => setCustomPrefix(e.target.value)}
                                    placeholder="e.g. platform/images"
                                    className="bg-zinc-900 border-zinc-800 font-mono text-sm placeholder:text-zinc-700"
                                />
                            </div>

                            {error && (
                                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-md">
                                    <p className="text-sm font-medium text-red-500">{error}</p>
                                </div>
                            )}

                            {!selectedFile ? (
                                <div 
                                    className={`border-2 border-dashed rounded-lg p-10 flex flex-col items-center justify-center text-center cursor-pointer transition-all duration-200 ${
                                        isDragActive ? 'border-primary bg-primary/10' : 'border-zinc-800 hover:border-zinc-600 hover:bg-zinc-900/50 bg-zinc-900/30'
                                    }`}
                                    onDragEnter={handleDrag}
                                    onDragLeave={handleDrag}
                                    onDragOver={handleDrag}
                                    onDrop={handleDrop}
                                    onClick={() => fileInputRef.current?.click()}
                                >
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        className="hidden"
                                        onChange={handleChange}
                                    />
                                    <div className="h-14 w-14 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-5 shadow-sm">
                                        <UploadCloud className="h-6 w-6 text-zinc-400" />
                                    </div>
                                    <p className="text-sm font-medium text-zinc-200 mb-2">
                                        Drag & drop a file here or browse
                                    </p>
                                    <p className="text-xs text-zinc-500 max-w-[200px] leading-relaxed">
                                        Supports generic payload types up to infrastructure limits.
                                    </p>
                                </div>
                            ) : (
                                <div className="border border-zinc-800 bg-zinc-900/50 rounded-lg p-4 flex items-center gap-4 group hover:border-zinc-700 transition-colors">
                                    <div className="h-12 w-12 bg-zinc-950 border border-zinc-800 rounded-md flex items-center justify-center shrink-0">
                                        <File className="h-6 w-6 text-zinc-400" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-zinc-200 truncate shadow-sm">
                                            {selectedFile.name}
                                        </p>
                                        <p className="text-xs font-medium text-zinc-500 mt-1">
                                            {formatFileSize(selectedFile.size)} • <span className="font-mono">{selectedFile.type || "octet-stream"}</span>
                                        </p>
                                    </div>
                                    <Button 
                                        variant="ghost" 
                                        size="icon" 
                                        className="shrink-0 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-50 group-hover:opacity-100"
                                        onClick={() => setSelectedFile(null)}
                                    >
                                        <X className="h-4 w-4" />
                                    </Button>
                                </div>
                            )}
                        </>
                    )}
                </div>

                {!uploadComplete && (
                    <DialogFooter className="pt-4 border-t border-zinc-800/50">
                        <Button 
                            variant="outline" 
                            onClick={handleClose} 
                            disabled={uploading}
                        >
                            Cancel
                        </Button>
                        <Button 
                            onClick={handleUpload} 
                            disabled={!selectedFile || uploading}
                        >
                            {uploading ? (
                                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Uploading</>
                            ) : (
                                "Initiate Upload"
                            )}
                        </Button>
                    </DialogFooter>
                )}
            </DialogContent>
        </Dialog>
    );
}
