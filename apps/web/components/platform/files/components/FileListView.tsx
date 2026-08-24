"use client";

import { Loader2, Download, Trash2, Folder as FolderIcon, Play, RefreshCw } from "lucide-react";
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { isIngestibleCategory, getFileCategory, isParseable } from "../fileCategory";
import { getFileIcon } from "../lib/fileIcons";
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
}

export function FileListView({
    folderCards, files, selectedFile, onSelectFile, selectedIds, onToggleSelect,
    allPageSelected, onToggleSelectAll, ingestingFiles, onIngestFile, onIngestFolder,
    onNavigateToFolder, onDownload, canDelete, onDeleteFile, onDeleteFolder,
}: FileListViewProps) {
    return (
        <div className="flex-1 border border-border rounded-lg bg-card overflow-hidden min-w-0">
            <Table>
                <TableHeader className="bg-muted/50">
                    <TableRow className="border-border hover:bg-transparent">
                        <TableHead className="w-10">
                            <Checkbox checked={allPageSelected} onCheckedChange={onToggleSelectAll} />
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
                    {folderCards.map(({ folderName, folderPrefix, allDone, isIngesting }) => (
                        <TableRow
                            key={`folder-${folderName}`}
                            onClick={() => onNavigateToFolder(folderPrefix)}
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
                                        onClick={() => onIngestFolder(folderName)}
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
