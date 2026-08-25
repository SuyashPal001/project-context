"use client";

import { Loader2, Download, Trash2, Folder as FolderIcon, Play, RefreshCw } from "lucide-react";
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { isIngestibleCategory, getFileCategory, isParseable } from "../fileCategory";
import { getFileIcon, formatFileSize } from "../lib/fileIcons";
import { ProcessingStepsIndicator } from "./IngestionStatus";
import type { FileRecord, FolderCard } from "../types";

interface FileListViewProps {
    folderCards: FolderCard[];
    files: FileRecord[];
    selectedFile: FileRecord | null;
    onSelectFile: (file: FileRecord | null) => void;
    selectedIds: Set<string>;
    onToggleSelect: (id: string) => void;
    allPageSelected: boolean;
    onToggleSelectAll: () => void;
    ingestingFiles: Set<string>;
    onIngestFile: (fileId: string) => void;
    onIngestFolder: (folderName: string) => void;
    onNavigateToFolder: (folderPrefix: string) => void;
    onDownload: (fileId: string) => void;
    canDelete: boolean;
    onDeleteFile: (fileId: string) => void;
    onDeleteFolder: (folderName: string) => void;
    showPipelineDetails?: boolean;
}

function QuietStatusIndicator({ status }: { status: FileRecord['ingestionStatus'] }) {
    const config: Record<string, { label: string; dotClassName: string }> = {
        done:       { label: 'Ready',      dotClassName: 'bg-green-500' },
        processing: { label: 'Processing', dotClassName: 'bg-amber-400' },
        pending:    { label: 'Processing', dotClassName: 'bg-amber-400' },
        failed:     { label: 'Failed',     dotClassName: 'bg-red-500' },
    };
    const cfg = config[status] ?? { label: status, dotClassName: 'bg-muted-foreground' };
    return (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={`w-1.5 h-1.5 rounded-full ${cfg.dotClassName}`} />
            {cfg.label}
        </span>
    );
}

export function FileListView({
    folderCards, files, selectedFile, onSelectFile, selectedIds, onToggleSelect,
    allPageSelected, onToggleSelectAll, ingestingFiles, onIngestFile, onIngestFolder,
    onNavigateToFolder, onDownload, canDelete, onDeleteFile, onDeleteFolder,
    showPipelineDetails = false,
}: FileListViewProps) {
    const columnCount = 6 + (showPipelineDetails ? 4 : 0);
    // table-fixed hands any undeclared width to the one unsized column, so the
    // default view declares a share for every column — otherwise Name absorbs
    // the whole remainder and opens a gap before Size. The pipeline view has
    // enough columns to fill the row on its own.
    const col = showPipelineDetails
        ? { name: '', size: 'w-24', status: 'w-40', added: 'w-28', actions: 'w-28' }
        : { name: 'w-[36%]', size: 'w-[13%]', status: 'w-[17%]', added: 'w-[15%]', actions: 'w-[15%]' };
    return (
        <div className="flex-1 border border-border rounded-lg bg-card overflow-hidden min-w-0">
            <Table className="table-fixed">
                <TableHeader className="bg-muted/50">
                    <TableRow className="border-border hover:bg-transparent">
                        <TableHead className="w-10">
                            <Checkbox checked={allPageSelected} onCheckedChange={onToggleSelectAll} />
                        </TableHead>
                        <TableHead className={col.name}>Name</TableHead>
                        <TableHead className={`${col.size} text-right`}>Size</TableHead>
                        {showPipelineDetails && <TableHead className="w-24">Format</TableHead>}
                        {showPipelineDetails && <TableHead className="w-32">Workspace</TableHead>}
                        {showPipelineDetails && <TableHead className="w-36">Classification</TableHead>}
                        {showPipelineDetails && <TableHead className="w-20 text-right">Chunks</TableHead>}
                        <TableHead className={col.status}>Status</TableHead>
                        <TableHead className={col.added}>Added</TableHead>
                        <TableHead className={`${col.actions} text-right`}>Actions</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {folderCards.map(({ folderName, folderPrefix, allDone, isIngesting }) => (
                        <TableRow
                            key={`folder-${folderName}`}
                            onClick={() => onNavigateToFolder(folderPrefix)}
                            className="cursor-pointer border-border/50 hover:bg-secondary/60 transition-colors"
                        >
                            <TableCell className="py-3" onClick={e => e.stopPropagation()} />
                            <TableCell className="py-3" colSpan={columnCount - 2}>
                                <div className="flex items-center gap-2">
                                    <FolderIcon className="w-4 h-4 text-amber-500 fill-amber-500/20" />
                                    <span className="font-medium text-foreground">{folderName}/</span>
                                </div>
                            </TableCell>
                            <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                                <div className="flex items-center justify-end gap-1">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 text-muted-foreground hover:text-green-400"
                                        title={isIngesting ? 'Ingesting…' : 'Ingest'}
                                        onClick={() => onIngestFolder(folderName)}
                                        disabled={allDone || isIngesting}
                                    >
                                        {isIngesting
                                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                            : <Play className="w-3.5 h-3.5" />}
                                    </Button>
                                    {canDelete && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-7 w-7 text-muted-foreground hover:text-red-500"
                                            onClick={() => onDeleteFolder(folderName)}
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </Button>
                                    )}
                                </div>
                            </TableCell>
                        </TableRow>
                    ))}
                    {files.map(file => {
                        const isIngestible = isIngestibleCategory(getFileCategory(file.contentType, file.filename));
                        return (
                        <TableRow
                            key={file.id}
                            className={`border-border/50 hover:bg-secondary/60 transition-colors cursor-pointer ${selectedFile?.id === file.id ? 'bg-secondary/60 border-l-2 border-l-blue-500' : ''}`}
                            onClick={() => onSelectFile(selectedFile?.id === file.id ? null : file)}
                        >
                            <TableCell className="w-10 py-3 align-middle" onClick={e => e.stopPropagation()}>
                                <Checkbox checked={selectedIds.has(file.id)} onCheckedChange={() => onToggleSelect(file.id)} />
                            </TableCell>
                            <TableCell className="py-3">
                                <div className="flex items-center gap-2 min-w-0">
                                    <span className="shrink-0">{getFileIcon(file.contentType)}</span>
                                    <span className="text-foreground/80 truncate text-sm font-medium" title={file.filename}>{file.filename}</span>
                                </div>
                            </TableCell>
                            <TableCell className="text-right text-xs font-mono text-muted-foreground">
                                {formatFileSize(file.size)}
                            </TableCell>
                            {showPipelineDetails && (
                                <TableCell>
                                    <span className="text-xs font-mono text-muted-foreground">
                                        {file.formatDetected ?? '—'}
                                    </span>
                                </TableCell>
                            )}
                            {showPipelineDetails && (
                                <TableCell className="py-3">
                                    {file.workspaceName ? (
                                        <span className="text-xs bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded font-mono">
                                            {file.workspaceName}
                                        </span>
                                    ) : (
                                        <span className="text-xs text-muted-foreground/50">—</span>
                                    )}
                                </TableCell>
                            )}
                            {showPipelineDetails && (
                                <TableCell className="py-3">
                                    <span className={`text-xs px-2 py-0.5 rounded font-medium border ${file.classification === 'Confidential' ? 'border-red-500/30 text-red-400 bg-red-500/10' : 'border-amber-500/30 text-amber-400 bg-amber-500/10'}`}>
                                        {file.classification}
                                    </span>
                                </TableCell>
                            )}
                            {showPipelineDetails && (
                                <TableCell className="text-muted-foreground text-sm">
                                    {isIngestible && file.chunkCount > 0 ? file.chunkCount : '—'}
                                </TableCell>
                            )}
                            <TableCell>
                                {isIngestible && (showPipelineDetails
                                    ? <ProcessingStepsIndicator status={file.ingestionStatus} />
                                    : <QuietStatusIndicator status={file.ingestionStatus} />)}
                            </TableCell>
                            <TableCell className="text-xs font-mono text-muted-foreground">
                                {format(new Date(file.createdAt), 'dd MMM yyyy')}
                            </TableCell>
                            <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                                <div className="flex items-center justify-end gap-1">
                                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={() => onDownload(file.id)}>
                                        <Download className="w-3.5 h-3.5" />
                                    </Button>
                                    {isParseable(file) && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-7 w-7 text-muted-foreground hover:text-green-400"
                                            title="Ingest"
                                            onClick={() => onIngestFile(file.id)}
                                            disabled={ingestingFiles.has(file.id)}
                                        >
                                            {ingestingFiles.has(file.id)
                                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                : <RefreshCw className="w-3.5 h-3.5" />}
                                        </Button>
                                    )}
                                    {canDelete && (
                                        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-red-500" onClick={() => onDeleteFile(file.id)}>
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
    );
}
