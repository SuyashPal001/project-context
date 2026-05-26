"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { EmptyState, ConfirmDialog } from "@/components/platform/shared";
import {
    Loader2, FolderOpen, FileText, Image as ImageIcon, Video, Music, FileCode, File, Download, Trash2, Folder as FolderIcon, ChevronRight
} from "lucide-react";
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { formatDistanceToNow } from "date-fns";
import { useState, useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { IngestionSidePanel } from "./IngestionSidePanel";

interface ExtractedField {
    key: string;
    label: string;
    value: string;
    confidence: number;
}

interface FileRecord {
    id: string;
    tenantId: string;
    key: string;
    filename: string;
    contentType: string;
    size: number;
    uploadedBy: string;
    createdAt: string;
    updatedAt: string;
    // Ingestion metadata
    formatDetected: string | null;
    officeCode: string;
    classification: string;
    chunkCount: number;
    ingestionStatus: 'pending' | 'processing' | 'done' | 'failed';
    extractedFields: ExtractedField[] | null;
}

interface FilesListProps {
    prefix: string;
    onPrefixChange: (prefix: string) => void;
    onUploadClick: () => void;
    canUpload: boolean;
    canDelete: boolean;
}

function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

const getFileIcon = (contentType: string) => {
    if (contentType.includes('pdf')) return <FileText className="w-4 h-4 text-zinc-400" />;
    if (contentType.includes('image')) return <ImageIcon className="w-4 h-4 text-zinc-400" />;
    if (contentType.includes('video')) return <Video className="w-4 h-4 text-zinc-400" />;
    if (contentType.includes('audio')) return <Music className="w-4 h-4 text-zinc-400" />;
    if (contentType.includes('text') || contentType.includes('json') || contentType.includes('javascript')) return <FileCode className="w-4 h-4 text-zinc-400" />;
    return <File className="w-4 h-4 text-zinc-400" />;
};

function IngestionStatusBadge({ status }: { status: string }) {
    const config: Record<string, { label: string; className: string }> = {
        pending:    { label: 'Pending',      className: 'bg-zinc-500/10 text-zinc-400' },
        processing: { label: 'Processing…',  className: 'bg-amber-500/10 text-amber-400 animate-pulse' },
        done:       { label: '✅ Done',      className: 'bg-green-500/10 text-green-400' },
        failed:     { label: '❌ Failed',    className: 'bg-red-500/10 text-red-400' },
    };
    const cfg = config[status] ?? { label: status, className: 'bg-zinc-500/10 text-zinc-400' };
    return (
        <span className={`text-xs px-2 py-0.5 rounded font-medium ${cfg.className}`}>
            {cfg.label}
        </span>
    );
}

export function FilesList({ prefix, onPrefixChange, onUploadClick, canUpload, canDelete }: FilesListProps) {
    const queryClient = useQueryClient();
    const [deletingFileId, setDeletingFileId] = useState<string | null>(null);
    const [selectedFile, setSelectedFile] = useState<FileRecord | null>(null);

    const { data: response, isLoading } = useQuery({
        queryKey: ['files', prefix],
        queryFn: async () => {
            const params = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
            return api.get<{ data: FileRecord[] }>(`/api/v1/files${params}`);
        },
        refetchInterval: 5000, // poll every 5s so processing → done updates automatically
    });

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

    const downloadFile = async (fileId: string) => {
        try {
            const res = await api.get<{ data: { downloadUrl: string } }>(`/api/v1/files/${fileId}/download`);
            window.open(res.data.downloadUrl, '_blank');
        } catch {
            toast.error("Failed to get download URL");
        }
    };

    const breadcrumbs = useMemo(() => {
        if (!prefix) return [];
        const parts = prefix.split('/').filter(Boolean);
        return parts.map((part, index) => ({
            name: part,
            path: parts.slice(0, index + 1).join('/') + '/'
        }));
    }, [prefix]);

    const { virtualFolders, files } = useMemo(() => {
        const allFiles = response?.data || [];
        const folders = new Set<string>();
        const directFiles: FileRecord[] = [];

        allFiles.forEach(file => {
            const relativePath = prefix ? file.key.substring(prefix.length) : file.key;
            if (relativePath.includes('/')) {
                const folderName = relativePath.split('/')[0];
                folders.add(folderName);
            } else {
                directFiles.push(file);
            }
        });

        return {
            virtualFolders: Array.from(folders).sort(),
            files: directFiles.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        };
    }, [response?.data, prefix]);

    return (
        <div className="space-y-4">
            {/* Breadcrumb */}
            <div className="flex items-center text-sm text-zinc-400 bg-zinc-900/50 p-3 rounded-lg border border-zinc-800">
                <button onClick={() => onPrefixChange("")} className={`hover:text-zinc-200 transition-colors ${!prefix ? 'text-zinc-200 font-medium' : ''}`}>
                    Documents
                </button>
                {breadcrumbs.map((crumb, idx) => (
                    <div key={crumb.path} className="flex items-center">
                        <ChevronRight className="w-4 h-4 mx-1 opacity-50" />
                        <button onClick={() => onPrefixChange(crumb.path)} className={`hover:text-zinc-200 transition-colors ${idx === breadcrumbs.length - 1 ? 'text-zinc-200 font-medium' : ''}`}>
                            {crumb.name}
                        </button>
                    </div>
                ))}
            </div>

            {isLoading ? (
                <div className="flex justify-center py-12 flex-col items-center gap-4 text-muted-foreground border border-zinc-800 rounded-lg bg-card">
                    <Loader2 className="w-8 h-8 animate-spin" />
                    <p>Loading documents...</p>
                </div>
            ) : files.length === 0 && virtualFolders.length === 0 ? (
                <div className="py-8">
                    <EmptyState
                        icon={<FolderOpen className="w-12 h-12" />}
                        title={prefix ? "This folder is empty" : "No documents ingested yet"}
                        description="Upload pension documents, service books, or financial records to begin."
                        action={canUpload ? { label: "Ingest Document", onClick: onUploadClick } : undefined}
                    />
                </div>
            ) : (
                <div className="flex gap-4 items-start">
                    {/* Main table */}
                    <div className="flex-1 border border-zinc-800 rounded-lg bg-card overflow-hidden min-w-0">
                        <Table>
                            <TableHeader className="bg-muted/50">
                                <TableRow className="border-zinc-800 hover:bg-transparent">
                                    <TableHead>Document</TableHead>
                                    <TableHead>Format</TableHead>
                                    <TableHead>Office</TableHead>
                                    <TableHead>Classification</TableHead>
                                    <TableHead>Chunks</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead>Ingested</TableHead>
                                    <TableHead className="text-right">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {virtualFolders.map(folderName => (
                                    <TableRow
                                        key={`folder-${folderName}`}
                                        onClick={() => onPrefixChange(`${prefix}${folderName}/`)}
                                        className="cursor-pointer border-zinc-800/50 hover:bg-muted/40 transition-colors"
                                    >
                                        <TableCell colSpan={8}>
                                            <div className="flex items-center gap-2">
                                                <FolderIcon className="w-4 h-4 text-amber-500 fill-amber-500/20" />
                                                <span className="font-medium text-zinc-200">{folderName}/</span>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))}
                                {files.map(file => (
                                    <TableRow
                                        key={file.id}
                                        className={`border-zinc-800/50 hover:bg-muted/40 transition-colors cursor-pointer ${selectedFile?.id === file.id ? 'bg-muted/40 border-l-2 border-l-blue-500' : ''}`}
                                        onClick={() => setSelectedFile(selectedFile?.id === file.id ? null : file)}
                                    >
                                        <TableCell className="max-w-[180px]">
                                            <div className="flex items-center gap-2">
                                                {getFileIcon(file.contentType)}
                                                <span className="text-zinc-300 truncate text-sm font-medium" title={file.filename}>{file.filename}</span>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <span className="text-xs font-mono text-zinc-400">
                                                {file.formatDetected ?? '—'}
                                            </span>
                                        </TableCell>
                                        <TableCell>
                                            <span className="text-xs bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded font-mono">
                                                {file.officeCode}
                                            </span>
                                        </TableCell>
                                        <TableCell>
                                            <span className={`text-xs px-2 py-0.5 rounded font-medium ${file.classification === 'Confidential' ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400'}`}>
                                                {file.classification}
                                            </span>
                                        </TableCell>
                                        <TableCell className="text-zinc-400 text-sm">
                                            {file.chunkCount > 0 ? file.chunkCount : '—'}
                                        </TableCell>
                                        <TableCell>
                                            <IngestionStatusBadge status={file.ingestionStatus} />
                                        </TableCell>
                                        <TableCell className="text-zinc-400 text-sm">
                                            {formatDistanceToNow(new Date(file.createdAt), { addSuffix: true })}
                                        </TableCell>
                                        <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                                            <div className="flex items-center justify-end gap-1">
                                                <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-400 hover:text-zinc-200" onClick={() => downloadFile(file.id)}>
                                                    <Download className="w-3.5 h-3.5" />
                                                </Button>
                                                {canDelete && (
                                                    <Button variant="ghost" size="icon" className="h-7 w-7 text-zinc-400 hover:text-red-500" onClick={() => setDeletingFileId(file.id)}>
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </Button>
                                                )}
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>

                    {/* Side panel */}
                    {selectedFile && (
                        <IngestionSidePanel
                            file={selectedFile}
                            onClose={() => setSelectedFile(null)}
                        />
                    )}
                </div>
            )}

            <ConfirmDialog
                open={!!deletingFileId}
                onOpenChange={(open) => !open && setDeletingFileId(null)}
                title="Delete Document"
                description="Are you sure you want to permanently delete this document? This action cannot be undone."
                confirmLabel="Delete"
                variant="danger"
                onConfirm={() => { if (deletingFileId) deleteMutation.mutate(deletingFileId); }}
                loading={deleteMutation.isPending}
            />
        </div>
    );
}
