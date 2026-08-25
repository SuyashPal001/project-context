"use client";

import { Loader2, Download, Trash2, Folder as FolderIcon, Play, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FileThumbnail } from "../FileThumbnail";
import { getFileCategory, isIngestibleCategory, isParseable } from "../fileCategory";
import { getFileIcon } from "../lib/fileIcons";
import { ProcessingStepsIndicator } from "./IngestionStatus";
import { AddToChatMenu } from "./AddToChatMenu";
import { MAX_FILES_PER_SELECTION } from "@/components/platform/chat/useFileUpload";
import type { Conversation } from "@/components/platform/chat/types";
import type { FileRecord, FolderCard } from "../types";

interface FileGridViewProps {
    folderCards: FolderCard[];
    files: FileRecord[];
    selectedFile: FileRecord | null;
    onSelectFile: (file: FileRecord | null) => void;
    selectedIds: Set<string>;
    onToggleSelect: (id: string) => void;
    ingestingFiles: Set<string>;
    onIngestFile: (fileId: string) => void;
    onIngestFolder: (folderName: string) => void;
    onNavigateToFolder: (folderPrefix: string) => void;
    onDownload: (fileId: string) => void;
    canDelete: boolean;
    onDeleteFile: (fileId: string) => void;
    onDeleteFolder: (folderName: string) => void;
    conversations: Conversation[];
    onAddToChat: (files: FileRecord[], conversationId: string | null) => void;
    onAddFolderToChat: (folderPrefix: string, conversationId: string | null) => void;
    showPipelineDetails?: boolean;
}

export function FileGridView({
    folderCards, files, selectedFile, onSelectFile, selectedIds, onToggleSelect,
    ingestingFiles, onIngestFile, onIngestFolder, onNavigateToFolder, onDownload,
    canDelete, onDeleteFile, onDeleteFolder, conversations, onAddToChat, onAddFolderToChat,
    showPipelineDetails = false,
}: FileGridViewProps) {
    return (
        <div className="flex-1 min-w-0 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {folderCards.map(({ folderName, folderPrefix, allDone, isIngesting, fileCount }) => (
                <div
                    key={`folder-${folderName}`}
                    onClick={() => onNavigateToFolder(folderPrefix)}
                    className="group relative flex flex-col p-3 rounded-xl border border-border bg-card hover:bg-secondary/60 transition-colors cursor-pointer"
                >
                    <div className="flex items-center gap-2 mb-2">
                        <FolderIcon className="w-5 h-5 text-amber-500 fill-amber-500/20 shrink-0" />
                        <span className="font-medium text-foreground text-sm truncate" title={`${folderName}/`}>{folderName}/</span>
                    </div>
                    <div className="flex items-center justify-end gap-1 mt-auto opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                        <AddToChatMenu
                            conversations={conversations}
                            variant="icon"
                            disabled={fileCount === 0 || fileCount > MAX_FILES_PER_SELECTION}
                            label={fileCount > MAX_FILES_PER_SELECTION ? `Too many files (${fileCount})` : 'Add to chat'}
                            onPick={(conversationId) => onAddFolderToChat(folderPrefix, conversationId)}
                        />
                        {showPipelineDetails && (
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-muted-foreground hover:text-green-400"
                                title="Ingest"
                                onClick={() => onIngestFolder(folderName)}
                                disabled={allDone || isIngesting}
                            >
                                {isIngesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                            </Button>
                        )}
                        {canDelete && (
                            <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={() => onDeleteFolder(folderName)}>
                                <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                        )}
                    </div>
                </div>
            ))}
            {files.map(file => {
                const category = getFileCategory(file.contentType, file.filename);
                const isIngestible = isIngestibleCategory(category);
                const isSelected = selectedIds.has(file.id);
                return (
                    <div
                        key={file.id}
                        onClick={showPipelineDetails ? () => onSelectFile(selectedFile?.id === file.id ? null : file) : undefined}
                        className={`group relative flex flex-col rounded-xl border bg-card hover:bg-secondary/60 transition-colors overflow-hidden ${showPipelineDetails ? 'cursor-pointer' : ''} ${selectedFile?.id === file.id ? 'border-l-2 border-l-primary border-border' : 'border-border'}`}
                    >
                        <div className="absolute top-2 left-2 z-10" onClick={e => e.stopPropagation()}>
                            <Checkbox
                                checked={isSelected}
                                className="bg-background/70 backdrop-blur-sm"
                                onCheckedChange={() => onToggleSelect(file.id)}
                            />
                        </div>
                        <div className="aspect-square w-full bg-muted/20 flex items-center justify-center">
                            {category === 'image' ? (
                                <FileThumbnail fileId={file.id} alt={file.filename} />
                            ) : category === 'audio-video' && file.contentType.startsWith('video') ? (
                                <div className="w-full h-full flex items-center justify-center bg-muted/40">
                                    <div className="h-9 w-9 rounded-full bg-background/80 flex items-center justify-center">
                                        <Play className="w-4 h-4 text-foreground/70 ml-0.5" />
                                    </div>
                                </div>
                            ) : (
                                <div className="scale-[2.2]">{getFileIcon(file.contentType)}</div>
                            )}
                        </div>
                        <div className="p-2.5 flex flex-col gap-1">
                            <span className="text-xs font-medium text-foreground/80 truncate" title={file.filename}>{file.filename}</span>
                            <div className="flex items-center gap-1 flex-wrap">
                                {showPipelineDetails && isIngestible ? (
                                    <ProcessingStepsIndicator status={file.ingestionStatus} />
                                ) : (
                                    <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wide">
                                        {showPipelineDetails ? (file.formatDetected ?? category) : category}
                                    </span>
                                )}
                            </div>
                        </div>
                        <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                            <AddToChatMenu
                                conversations={conversations}
                                variant="icon"
                                triggerClassName="bg-background/70 backdrop-blur-sm"
                                onPick={(conversationId) => onAddToChat([file], conversationId)}
                            />
                            <Button variant="ghost" size="icon" className="h-6 w-6 bg-background/70 backdrop-blur-sm text-muted-foreground hover:text-foreground" onClick={() => onDownload(file.id)}>
                                <Download className="w-3 h-3" />
                            </Button>
                            {showPipelineDetails && isParseable(file) && (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 bg-background/70 backdrop-blur-sm text-muted-foreground hover:text-green-400"
                                    title="Ingest"
                                    onClick={() => onIngestFile(file.id)}
                                    disabled={ingestingFiles.has(file.id)}
                                >
                                    {ingestingFiles.has(file.id) ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                                </Button>
                            )}
                            {canDelete && (
                                <Button variant="ghost" size="icon" className="h-6 w-6 bg-background/70 backdrop-blur-sm text-muted-foreground hover:text-destructive" onClick={() => onDeleteFile(file.id)}>
                                    <Trash2 className="w-3 h-3" />
                                </Button>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
