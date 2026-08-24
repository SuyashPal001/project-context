"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { EmptyState, ConfirmDialog } from "@/components/platform/shared";
import {
    Loader2, FolderOpen, FileText, Image as ImageIcon, Video, Music, FileCode, File, Download, Trash2, Folder as FolderIcon, ChevronRight, ChevronLeft, RefreshCw, Play, MessageSquare
} from "lucide-react";
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { formatDistanceToNow } from "date-fns";
import { useState, useMemo, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { IngestionSidePanel } from "./IngestionSidePanel";
import { FilesFilter } from "./FilesFilter";
import { getFileCategory, isIngestibleCategory } from "./fileCategory";

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
    formatDetected: string | null;
    officeCode: string | null;
    classification: string;
    chunkCount: number;
    ingestionStatus: 'pending' | 'processing' | 'done' | 'failed';
    extractedFields: ExtractedField[] | null;
    personFolderId: string | null;
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
    if (contentType.includes('pdf')) return <FileText className="w-4 h-4 text-muted-foreground" />;
    if (contentType.includes('image')) return <ImageIcon className="w-4 h-4 text-muted-foreground" />;
    if (contentType.includes('video')) return <Video className="w-4 h-4 text-muted-foreground" />;
    if (contentType.includes('audio')) return <Music className="w-4 h-4 text-muted-foreground" />;
    if (contentType.includes('text') || contentType.includes('json') || contentType.includes('javascript')) return <FileCode className="w-4 h-4 text-muted-foreground" />;
    return <File className="w-4 h-4 text-muted-foreground" />;
};

function IngestionStatusBadge({ status }: { status: string }) {
    const config: Record<string, { label: string; className: string }> = {
        pending:    { label: 'Pending',      className: 'bg-muted/50 text-muted-foreground' },
        processing: { label: 'Processing…',  className: 'bg-amber-500/10 text-amber-400 animate-pulse' },
        done:       { label: '✅ Done',      className: 'bg-green-500/10 text-green-400' },
        failed:     { label: '❌ Failed',    className: 'bg-red-500/10 text-red-400' },
    };
    const cfg = config[status] ?? { label: status, className: 'bg-muted/50 text-muted-foreground' };
    return (
        <span className={`text-xs px-2 py-0.5 rounded font-medium ${cfg.className}`}>
            {cfg.label}
        </span>
    );
}

const PIPELINE_STAGES = ['detectFormat', 'classify', 'extract', 'validate', 'embed'];

function ProcessingStepsIndicator({ status }: { status: string }) {
    const [currentStep, setCurrentStep] = useState(0);

    useEffect(() => {
        if (status !== 'processing') { setCurrentStep(0); return; }
        setCurrentStep(0);
        const timer = setInterval(() => {
            setCurrentStep(prev => Math.min(prev + 1, PIPELINE_STAGES.length - 1));
        }, 8000);
        return () => clearInterval(timer);
    }, [status]);

    if (status !== 'processing') return <IngestionStatusBadge status={status} />;

    return (
        <div className="flex items-center gap-1">
            {PIPELINE_STAGES.map((stage, idx) => (
                <div
                    key={stage}
                    className={`w-1.5 h-1.5 rounded-full transition-colors ${
                        idx < currentStep ? 'bg-green-500' :
                        idx === currentStep ? 'bg-amber-400 animate-pulse' :
                        'bg-muted'
                    }`}
                    title={stage}
                />
            ))}
            <span className="text-xs text-amber-400 ml-1 font-mono">{PIPELINE_STAGES[currentStep]}</span>
        </div>
    );
}

export function FilesList({ prefix, onPrefixChange, onUploadClick, canUpload, canDelete }: FilesListProps) {
    const queryClient = useQueryClient();
    const params = useParams();
    const router = useRouter();
    const tenant = params.tenant as string;

    const { data: agentsData } = useQuery({
        queryKey: ['agents'],
        queryFn: () => api.get<{ data: { id: string; name: string; status: string }[] }>('/api/v1/agents'),
    });
    const defaultAgentId = agentsData?.data?.find(a => a.status === 'active')?.id ?? null;

    const [deletingFileId, setDeletingFileId] = useState<string | null>(null);
    const [deletingFolderName, setDeletingFolderName] = useState<string | null>(null);
    const [selectedFile, setSelectedFile] = useState<FileRecord | null>(null);
    const [filterOffice, setFilterOffice] = useState("all");
    const [filterClassification, setFilterClassification] = useState("all");
    const [filterCategory, setFilterCategory] = useState("all");
    const [currentPage, setCurrentPage] = useState(1);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [bulkDeleting, setBulkDeleting] = useState(false);
    const PAGE_SIZE = 10;

    const { data: response, isLoading } = useQuery({
        queryKey: ['files', prefix],
        queryFn: async () => {
            const params = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
            return api.get<{ data: FileRecord[] }>(`/api/v1/files${params}`);
        },
        refetchInterval: 5000,
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

    const [ingestingFiles, setIngestingFiles] = useState<Set<string>>(new Set());

    const ingestFile = async (fileId: string) => {
        setIngestingFiles(prev => new Set([...prev, fileId]));
        try {
            const res = await fetch(`/api/proxy/api/v1/files/${fileId}/ingest`, { method: 'POST' });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || body.message || `Ingestion failed (HTTP ${res.status})`);
            }
            queryClient.invalidateQueries({ queryKey: ['files'] });
        } catch (err: any) {
            toast.error(err.message || "Failed to start ingestion");
        } finally {
            setIngestingFiles(prev => { const n = new Set(prev); n.delete(fileId); return n; });
        }
    };

    const [ingestingFolders, setIngestingFolders] = useState<Set<string>>(new Set());

    const ingestFolder = async (folderName: string) => {
        const folderPrefix = `${prefix}${folderName}/`;
        const pending = (response?.data ?? []).filter(
            f => f.key.startsWith(folderPrefix) && f.ingestionStatus !== 'done'
                && isIngestibleCategory(getFileCategory(f.contentType, f.filename))
        );
        if (pending.length === 0) return;
        // Navigate into folder first so user sees per-file progress
        onPrefixChange(folderPrefix);
        setIngestingFolders(prev => new Set([...prev, folderName]));
        let failCount = 0;
        for (const file of pending) {
            try {
                const res = await fetch(`/api/proxy/api/v1/files/${file.id}/ingest`, { method: 'POST' });
                if (!res.ok) failCount++;
            } catch { failCount++; }
        }
        setIngestingFolders(prev => { const n = new Set(prev); n.delete(folderName); return n; });
        queryClient.invalidateQueries({ queryKey: ['files'] });
        if (failCount > 0) toast.error(`Failed to start ingestion for ${failCount} of ${pending.length} file${pending.length !== 1 ? 's' : ''}`);
        else toast.success(`Ingestion queued for folder "${folderName}"`);
    };

    const [isIngestingAllInFolder, setIsIngestingAllInFolder] = useState(false);

    // Parse/ingest every pending or failed document directly in the current folder —
    // unlike ingestFolder (triggered from the parent listing row), this runs from
    // inside the folder view where the user is actually looking at the documents.
    const ingestAllInFolder = async () => {
        const pending = files.filter(f =>
            (f.ingestionStatus === 'pending' || f.ingestionStatus === 'failed')
            && isIngestibleCategory(getFileCategory(f.contentType, f.filename))
        );
        if (pending.length === 0) return;
        setIsIngestingAllInFolder(true);
        let failCount = 0;
        for (const file of pending) {
            try {
                const res = await fetch(`/api/proxy/api/v1/files/${file.id}/ingest`, { method: 'POST' });
                if (!res.ok) failCount++;
            } catch { failCount++; }
        }
        setIsIngestingAllInFolder(false);
        queryClient.invalidateQueries({ queryKey: ['files'] });
        if (failCount > 0) toast.error(`Failed to start ingestion for ${failCount} of ${pending.length} file${pending.length !== 1 ? 's' : ''}`);
        else toast.success(`Parsing started for ${pending.length} file${pending.length !== 1 ? 's' : ''}`);
    };

    const deleteFolder = async (folderName: string) => {
        const folderPrefix = `${prefix}${folderName}/`;
        const folderFiles = (response?.data ?? []).filter(f => f.key.startsWith(folderPrefix));
        for (const file of folderFiles) {
            try { await api.del(`/api/v1/files/${file.id}`); } catch { /* continue */ }
        }
        // Clean up the person folder record by identifier
        try {
            const lookup = await api.get<{ found: boolean; data?: { id: string } }>(`/api/v1/person-folders/lookup?identifier=${encodeURIComponent(folderName)}`);
            if (lookup.found && lookup.data?.id) {
                await api.del(`/api/v1/person-folders/${lookup.data.id}`);
            }
        } catch { /* continue */ }
        setDeletingFolderName(null);
        queryClient.invalidateQueries({ queryKey: ['files'] });
        queryClient.invalidateQueries({ queryKey: ['person-folders'] });
        toast.success(`Folder "${folderName}" deleted`);
    };

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

    const { virtualFolders, files, officeCodes } = useMemo(() => {
        const allFiles = response?.data || [];
        const folders = new Set<string>();
        const directFiles: FileRecord[] = [];

        allFiles.forEach(file => {
            if (prefix && !file.key.startsWith(prefix)) return;
            const relativePath = prefix ? file.key.substring(prefix.length) : file.key;
            if (relativePath.includes('/')) {
                const folderName = relativePath.split('/')[0];
                if (folderName) folders.add(folderName);
            } else {
                directFiles.push(file);
            }
        });

        return {
            virtualFolders: Array.from(folders).sort(),
            officeCodes: Array.from(new Set(allFiles.map(f => f.officeCode).filter(Boolean))).sort() as string[],
            files: directFiles.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        };
    }, [response?.data, prefix]);

    const filteredFiles = files.filter(f =>
        (filterOffice === "all" || f.officeCode === filterOffice) &&
        (filterClassification === "all" || f.classification === filterClassification) &&
        (filterCategory === "all" || getFileCategory(f.contentType, f.filename) === filterCategory));

    const totalPages = Math.max(1, Math.ceil(filteredFiles.length / PAGE_SIZE));
    const pagedFiles = filteredFiles.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
    const allPageSelected = pagedFiles.length > 0 && pagedFiles.every(f => selectedIds.has(f.id));

    const toggleSelectAll = () => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (allPageSelected) pagedFiles.forEach(f => next.delete(f.id));
            else pagedFiles.forEach(f => next.add(f.id));
            return next;
        });
    };

    const bulkDelete = async () => {
        setBulkDeleting(true);
        for (const id of selectedIds) {
            try { await api.del(`/api/v1/files/${id}`); } catch { /* continue */ }
        }
        setBulkDeleting(false);
        setSelectedIds(new Set());
        queryClient.invalidateQueries({ queryKey: ['files'] });
        toast.success(`Deleted ${selectedIds.size} file${selectedIds.size !== 1 ? 's' : ''}`);
    };

    return (
        <div className="space-y-4">
            {/* Breadcrumb */}
            <div className="flex items-center text-sm text-muted-foreground">
                <button onClick={() => onPrefixChange("")} className={`hover:text-foreground transition-colors ${!prefix ? 'text-foreground font-medium' : ''}`}>
                    Drive
                </button>
                {breadcrumbs.map((crumb, idx) => (
                    <div key={crumb.path} className="flex items-center">
                        <ChevronRight className="w-4 h-4 mx-1 opacity-50" />
                        <button onClick={() => onPrefixChange(crumb.path)} className={`hover:text-foreground transition-colors ${idx === breadcrumbs.length - 1 ? 'text-foreground font-medium' : ''}`}>
                            {crumb.name}
                        </button>
                    </div>
                ))}
            </div>

            {isLoading ? (
                <div className="flex justify-center py-12 flex-col items-center gap-4 text-muted-foreground border border-border rounded-lg bg-card">
                    <Loader2 className="w-8 h-8 animate-spin" />
                    <p>Loading documents...</p>
                </div>
            ) : files.length === 0 && virtualFolders.length === 0 ? (
                <div className="py-8">
                    <EmptyState
                        icon={<FolderOpen className="w-12 h-12" />}
                        title={prefix ? "This folder is empty" : "No files yet"}
                        description="Upload files to begin."
                        action={canUpload ? { label: "Upload", onClick: onUploadClick } : undefined}
                    />
                </div>
            ) : (
                <div className="space-y-2">
                    {prefix && (() => {
                        const folderPersonFolderId = (response?.data ?? [])
                            .filter(f => f.key.startsWith(prefix))
                            .find(f => f.personFolderId)?.personFolderId ?? null;
                        const folderIngestibleFiles = (response?.data ?? [])
                            .filter(f => f.key.startsWith(prefix))
                            .filter(f => isIngestibleCategory(getFileCategory(f.contentType, f.filename)));
                        const folderAllDone = folderIngestibleFiles.length > 0
                            && folderIngestibleFiles.every(f => f.ingestionStatus === 'done');
                        return folderPersonFolderId && folderAllDone ? (
                            <div className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-primary/10 border border-primary/20">
                                {/* text-shimmer-accent, not text-primary: the pale rose --primary
                                    fails WCAG AA as body text on the light theme (see globals.css) —
                                    --shimmer-accent is the same hue, darkened for readability there,
                                    and equal to --primary on the dark theme where it's already legible. */}
                                <div className="flex items-center gap-2 text-sm text-shimmer-accent">
                                    <MessageSquare className="w-4 h-4" />
                                    <span>All documents ingested — ready to chat</span>
                                </div>
                                <Button
                                    size="sm"
                                    className="h-7 text-xs gap-1.5"
                                    disabled={!defaultAgentId}
                                    onClick={() => defaultAgentId && router.push(`/${tenant}/dashboard/chat?agentId=${defaultAgentId}&folderId=${folderPersonFolderId}`)}
                                >
                                    <MessageSquare className="w-3 h-3" />
                                    Chat with Agent
                                </Button>
                            </div>
                        ) : null;
                    })()}
                    {prefix && <FilesFilter
                        officeCodes={officeCodes} filterOffice={filterOffice} onOfficeChange={v => { setFilterOffice(v); setCurrentPage(1); }}
                        filterClassification={filterClassification} onClassificationChange={v => { setFilterClassification(v); setCurrentPage(1); }}
                        filterCategory={filterCategory} onCategoryChange={v => { setFilterCategory(v); setCurrentPage(1); }}
                    />}
                    {prefix && files.some(f =>
                        (f.ingestionStatus === 'pending' || f.ingestionStatus === 'failed')
                        && isIngestibleCategory(getFileCategory(f.contentType, f.filename))
                    ) && (
                        <div className="flex justify-end">
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs gap-1.5"
                                onClick={ingestAllInFolder}
                                disabled={isIngestingAllInFolder}
                            >
                                {isIngestingAllInFolder
                                    ? <Loader2 className="w-3 h-3 animate-spin" />
                                    : <Play className="w-3 h-3" />}
                                {isIngestingAllInFolder ? 'Parsing…' : 'Parse All'}
                            </Button>
                        </div>
                    )}
                    {/* Bulk action bar */}
                    {selectedIds.size > 0 && (
                        <div className="flex items-center justify-between px-4 py-2 rounded-lg bg-secondary border border-border text-sm">
                            <span className="text-foreground/80">Selected: <strong>{selectedIds.size}</strong> {selectedIds.size === 1 ? 'file' : 'files'}</span>
                            <Button size="sm" variant="destructive" className="h-7 text-xs gap-1" onClick={bulkDelete} disabled={bulkDeleting}>
                                {bulkDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                                Delete Selected
                            </Button>
                        </div>
                    )}
                    <div className="flex gap-4 items-start">
                    {/* Main table */}
                    <div className="flex-1 border border-border rounded-lg bg-card overflow-hidden min-w-0">
                        <Table>
                            <TableHeader className="bg-muted/50">
                                <TableRow className="border-border hover:bg-transparent">
                                    <TableHead className="w-10">
                                        <Checkbox checked={allPageSelected} onCheckedChange={toggleSelectAll} />
                                    </TableHead>
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
                                {virtualFolders.map(folderName => {
                                    const folderPrefix = `${prefix}${folderName}/`;
                                    const folderFiles = (response?.data ?? []).filter(f => f.key.startsWith(folderPrefix));
                                    const allDone = folderFiles.length > 0 && folderFiles.every(f => f.ingestionStatus === 'done');
                                    const isIngesting = ingestingFolders.has(folderName);
                                    return (
                                        <TableRow
                                            key={`folder-${folderName}`}
                                            onClick={() => onPrefixChange(folderPrefix)}
                                            className="cursor-pointer border-border/50 hover:bg-secondary/60 transition-colors"
                                        >
                                            <TableCell className="py-3" onClick={e => e.stopPropagation()} />
                                            <TableCell className="py-3" colSpan={7}>
                                                <div className="flex items-center gap-2">
                                                    <FolderIcon className="w-4 h-4 text-amber-500 fill-amber-500/20" />
                                                    <span className="font-medium text-foreground">{folderName}/</span>
                                                </div>
                                            </TableCell>
                                            <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                                                <div className="flex items-center justify-end gap-1">
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-7 text-xs text-muted-foreground hover:text-green-400 gap-1"
                                                        onClick={() => ingestFolder(folderName)}
                                                        disabled={allDone || isIngesting}
                                                    >
                                                        {isIngesting
                                                            ? <Loader2 className="w-3 h-3 animate-spin" />
                                                            : <Play className="w-3 h-3" />}
                                                        {isIngesting ? 'Ingesting…' : 'Ingest'}
                                                    </Button>
                                                    {canDelete && (
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className="h-7 w-7 text-muted-foreground hover:text-red-500"
                                                            onClick={() => setDeletingFolderName(folderName)}
                                                        >
                                                            <Trash2 className="w-3.5 h-3.5" />
                                                        </Button>
                                                    )}
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                                {pagedFiles.map(file => {
                                    const isIngestible = isIngestibleCategory(getFileCategory(file.contentType, file.filename));
                                    return (
                                    <TableRow
                                        key={file.id}
                                        className={`border-border/50 hover:bg-secondary/60 transition-colors cursor-pointer ${selectedFile?.id === file.id ? 'bg-secondary/60 border-l-2 border-l-blue-500' : ''}`}
                                        onClick={() => setSelectedFile(selectedFile?.id === file.id ? null : file)}
                                    >
                                        <TableCell className="w-10 py-3 align-middle" onClick={e => e.stopPropagation()}>
                                            <Checkbox checked={selectedIds.has(file.id)}
                                                onCheckedChange={() => setSelectedIds(prev => { const n = new Set(prev); n.has(file.id) ? n.delete(file.id) : n.add(file.id); return n; })} />
                                        </TableCell>
                                        <TableCell className="max-w-[180px] py-3">
                                            <div className="flex items-center gap-2">
                                                {getFileIcon(file.contentType)}
                                                <span className="text-foreground/80 truncate text-sm font-medium" title={file.filename}>{file.filename}</span>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <span className="text-xs font-mono text-muted-foreground">
                                                {file.formatDetected ?? '—'}
                                            </span>
                                        </TableCell>
                                        <TableCell className="py-3">
                                            {file.officeCode ? (
                                                <span className="text-xs bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded font-mono">
                                                    {file.officeCode}
                                                </span>
                                            ) : (
                                                <span className="text-xs text-muted-foreground/50">—</span>
                                            )}
                                        </TableCell>
                                        <TableCell className="py-3">
                                            <span className={`text-xs px-2 py-0.5 rounded font-medium border ${file.classification === 'Confidential' ? 'border-red-500/30 text-red-400 bg-red-500/10' : 'border-amber-500/30 text-amber-400 bg-amber-500/10'}`}>
                                                {file.classification}
                                            </span>
                                        </TableCell>
                                        <TableCell className="text-muted-foreground text-sm">
                                            {isIngestible && file.chunkCount > 0 ? file.chunkCount : '—'}
                                        </TableCell>
                                        <TableCell>
                                            {isIngestible
                                                ? <ProcessingStepsIndicator status={file.ingestionStatus} />
                                                : <span className="text-xs text-muted-foreground/50">—</span>}
                                        </TableCell>
                                        <TableCell className="text-muted-foreground text-sm">
                                            {formatDistanceToNow(new Date(file.createdAt), { addSuffix: true })}
                                        </TableCell>
                                        <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                                            <div className="flex items-center justify-end gap-1">
                                                <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={() => downloadFile(file.id)}>
                                                    <Download className="w-3.5 h-3.5" />
                                                </Button>
                                                {isIngestible && (file.ingestionStatus === 'pending' || file.ingestionStatus === 'failed') && (
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-7 w-7 text-muted-foreground hover:text-green-400"
                                                        title="Ingest"
                                                        onClick={() => ingestFile(file.id)}
                                                        disabled={ingestingFiles.has(file.id)}
                                                    >
                                                        {ingestingFiles.has(file.id)
                                                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                            : <RefreshCw className="w-3.5 h-3.5" />}
                                                    </Button>
                                                )}
                                                {canDelete && (
                                                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-red-500" onClick={() => setDeletingFileId(file.id)}>
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </Button>
                                                )}
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                    );
                                })}
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

                    {/* Pagination */}
                    {totalPages > 1 && (
                        <div className="flex items-center justify-between pt-1">
                            <div className="flex items-center gap-1">
                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}>
                                    <ChevronLeft className="w-4 h-4" />
                                </Button>
                                {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                                    <Button key={page} variant={page === currentPage ? "secondary" : "ghost"} size="icon" className="h-7 w-7 text-xs" onClick={() => setCurrentPage(page)}>
                                        {page}
                                    </Button>
                                ))}
                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}>
                                    <ChevronRight className="w-4 h-4" />
                                </Button>
                            </div>
                            <span className="text-xs text-muted-foreground/70">Total {filteredFiles.length} files</span>
                        </div>
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

            <ConfirmDialog
                open={!!deletingFolderName}
                onOpenChange={(open) => !open && setDeletingFolderName(null)}
                title="Delete Folder"
                description={`Delete folder "${deletingFolderName}" and all its files? This cannot be undone.`}
                confirmLabel="Delete Folder"
                variant="danger"
                onConfirm={() => { if (deletingFolderName) deleteFolder(deletingFolderName); }}
                loading={false}
            />
        </div>
    );
}
