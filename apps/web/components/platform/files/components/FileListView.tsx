"use client";

import { Loader2, Download, Trash2, Folder as FolderIcon, Play, RefreshCw, MoreHorizontal, MessageSquare } from "lucide-react";
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
    onStartSession: (files: FileRecord[]) => void;
    showPipelineDetails?: boolean;
}

/** Shared trigger so the row menu sits in the same place on file and folder rows. */
function RowMenuTrigger() {
    return (
        <DropdownMenuTrigger asChild>
            <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 transition-opacity"
            >
                <MoreHorizontal className="w-4 h-4" />
            </Button>
        </DropdownMenuTrigger>
    );
}

export function FileListView({
    folderCards, files, selectedFile, onSelectFile, selectedIds, onToggleSelect,
    allPageSelected, onToggleSelectAll, ingestingFiles, onIngestFile, onIngestFolder,
    onNavigateToFolder, onDownload, canDelete, onDeleteFile, onDeleteFolder, onStartSession,
    showPipelineDetails = false,
}: FileListViewProps) {
    const columnCount = 5 + (showPipelineDetails ? 5 : 0);
    // table-fixed hands any undeclared width to the one unsized column, so the
    // default view declares a share for every column — otherwise Name absorbs the
    // whole remainder and opens a gap before Size. Equal shares for the three
    // metadata columns keep the gaps between them even. The pipeline view has
    // enough columns to fill the row on its own.
    const col = showPipelineDetails
        ? { name: '', size: 'w-24', added: 'w-28', actions: 'w-28' }
        : { name: 'w-[46%]', size: 'w-[19%]', added: 'w-[19%]', actions: 'w-[12%]' };
    return (
        <div className="flex-1 border border-border rounded-lg bg-card overflow-hidden min-w-0">
            <Table className="table-fixed [&_th]:px-4 [&_td]:px-4">
                <TableHeader className="bg-muted/50">
                    <TableRow className="border-border hover:bg-transparent">
                        <TableHead className="w-10">
                            <Checkbox checked={allPageSelected} onCheckedChange={onToggleSelectAll} />
                        </TableHead>
                        <TableHead className={col.name}>Name</TableHead>
                        <TableHead className={col.size}>Size</TableHead>
                        {showPipelineDetails && <TableHead className="w-24">Format</TableHead>}
                        {showPipelineDetails && <TableHead className="w-32">Workspace</TableHead>}
                        {showPipelineDetails && <TableHead className="w-36">Classification</TableHead>}
                        {showPipelineDetails && <TableHead className="w-20 text-right">Chunks</TableHead>}
                        {showPipelineDetails && <TableHead className="w-40">Status</TableHead>}
                        <TableHead className={col.added}>Added</TableHead>
                        <TableHead className={`${col.actions} text-right`}>Actions</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {folderCards.map(({ folderName, folderPrefix, allDone, isIngesting }) => (
                        <TableRow
                            key={`folder-${folderName}`}
                            onClick={() => onNavigateToFolder(folderPrefix)}
                            className="group cursor-pointer border-border/50 hover:bg-secondary/60 transition-colors"
                        >
                            <TableCell className="py-3" onClick={e => e.stopPropagation()} />
                            <TableCell className="py-3" colSpan={columnCount - 2}>
                                <div className="flex items-center gap-2">
                                    <FolderIcon className="w-4 h-4 text-amber-500 fill-amber-500/20" />
                                    <span className="font-medium text-foreground">{folderName}/</span>
                                </div>
                            </TableCell>
                            <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                                {(canDelete || showPipelineDetails) && (
                                    <DropdownMenu>
                                        <RowMenuTrigger />
                                        <DropdownMenuContent align="end" className="w-48">
                                            {showPipelineDetails && (
                                                <DropdownMenuItem
                                                    onClick={() => onIngestFolder(folderName)}
                                                    disabled={allDone || isIngesting}
                                                    className="gap-2 cursor-pointer"
                                                >
                                                    {isIngesting
                                                        ? <Loader2 className="w-4 h-4 animate-spin" />
                                                        : <Play className="w-4 h-4" />}
                                                    {isIngesting ? 'Ingesting…' : 'Ingest folder'}
                                                </DropdownMenuItem>
                                            )}
                                            {canDelete && (
                                                <>
                                                    {showPipelineDetails && <DropdownMenuSeparator />}
                                                    <DropdownMenuItem
                                                        onClick={() => onDeleteFolder(folderName)}
                                                        className="gap-2 cursor-pointer text-destructive focus:text-destructive"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                        Delete
                                                    </DropdownMenuItem>
                                                </>
                                            )}
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                )}
                            </TableCell>
                        </TableRow>
                    ))}
                    {files.map(file => {
                        const isIngestible = isIngestibleCategory(getFileCategory(file.contentType, file.filename));
                        return (
                        <TableRow
                            key={file.id}
                            className={`group border-border/50 hover:bg-secondary/60 transition-colors ${showPipelineDetails ? 'cursor-pointer' : ''} ${selectedFile?.id === file.id ? 'bg-secondary/60 border-l-2 border-l-primary' : ''}`}
                            onClick={showPipelineDetails ? () => onSelectFile(selectedFile?.id === file.id ? null : file) : undefined}
                        >
                            <TableCell className="w-10 py-3 align-middle" onClick={e => e.stopPropagation()}>
                                <Checkbox
                                    checked={selectedIds.has(file.id)}
                                    onCheckedChange={() => onToggleSelect(file.id)}
                                    className={`transition-opacity ${selectedIds.has(file.id) ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
                                />
                            </TableCell>
                            <TableCell className="py-3">
                                <div className="flex items-center gap-2 min-w-0">
                                    <span className="shrink-0">{getFileIcon(file.contentType)}</span>
                                    <span className="text-foreground/80 truncate text-sm font-medium" title={file.filename}>{file.filename}</span>
                                </div>
                            </TableCell>
                            <TableCell className="text-xs font-mono text-muted-foreground">
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
                            {showPipelineDetails && (
                                <TableCell>
                                    {isIngestible && <ProcessingStepsIndicator status={file.ingestionStatus} />}
                                </TableCell>
                            )}
                            <TableCell className="text-xs font-mono text-muted-foreground">
                                {format(new Date(file.createdAt), 'dd MMM yyyy')}
                            </TableCell>
                            <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                                <DropdownMenu>
                                    <RowMenuTrigger />
                                    <DropdownMenuContent align="end" className="w-48">
                                        <DropdownMenuItem onClick={() => onStartSession([file])} className="gap-2 cursor-pointer">
                                            <MessageSquare className="w-4 h-4" />
                                            Start session
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => onDownload(file.id)} className="gap-2 cursor-pointer">
                                            <Download className="w-4 h-4" />
                                            Download
                                        </DropdownMenuItem>
                                        {showPipelineDetails && isParseable(file) && (
                                            <DropdownMenuItem
                                                onClick={() => onIngestFile(file.id)}
                                                disabled={ingestingFiles.has(file.id)}
                                                className="gap-2 cursor-pointer"
                                            >
                                                {ingestingFiles.has(file.id)
                                                    ? <Loader2 className="w-4 h-4 animate-spin" />
                                                    : <RefreshCw className="w-4 h-4" />}
                                                {ingestingFiles.has(file.id) ? 'Ingesting…' : 'Re-ingest'}
                                            </DropdownMenuItem>
                                        )}
                                        {canDelete && (
                                            <>
                                                <DropdownMenuSeparator />
                                                <DropdownMenuItem
                                                    onClick={() => onDeleteFile(file.id)}
                                                    className="gap-2 cursor-pointer text-destructive focus:text-destructive"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                    Delete
                                                </DropdownMenuItem>
                                            </>
                                        )}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </TableCell>
                        </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    );
}
