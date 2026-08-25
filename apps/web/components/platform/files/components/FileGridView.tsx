"use client";

import { Loader2, Download, Trash2, Folder as FolderIcon, Play, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FileThumbnail } from "../FileThumbnail";
import { getFileCategory, isIngestibleCategory, isParseable } from "../fileCategory";
import type { FileCategory } from "../fileCategory";
import { assetTypeForFile } from "../lib/assetFromFile";
import { TYPE_ICONS, TYPE_BADGES, TYPE_STYLES } from "@/components/platform/canvas/assetTypeStyles";
import { useVideoFrameThumbnail } from "@/components/platform/canvas/videoFrameThumbnail";
import { ProcessingStepsIndicator } from "./IngestionStatus";
import { AddToChatMenu, folderChatLabel } from "./AddToChatMenu";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@/components/platform/chat/useFileUpload";
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
    onPreviewFile: (fileId: string) => void;
    onDownload: (fileId: string) => void;
    canDelete: boolean;
    onDeleteFile: (fileId: string) => void;
    onDeleteFolder: (folderName: string) => void;
    conversations: Conversation[];
    onAddToChat: (files: FileRecord[], conversationId: string | null) => void;
    onAddFolderToChat: (folderPrefix: string, conversationId: string | null) => void;
    showPipelineDetails?: boolean;
}

/** The tile art: the affordance to open the file, and the only place a hook can
 *  live — the grid body is a .map callback. Same type treatment the chat asset
 *  cards use, so a file looks the same wherever it is listed. */
function FileTileArt({ file, category, onPreview }: { file: FileRecord; category: FileCategory; onPreview: () => void }) {
    const assetType = assetTypeForFile(file.contentType, file.filename);
    const typeStyle = TYPE_STYLES[assetType];
    const TypeIcon = TYPE_ICONS[assetType];
    const videoFrameUrl = useVideoFrameThumbnail(file.id, assetType === 'video');

    return (
        <button
            type="button"
            onClick={e => { e.stopPropagation(); onPreview(); }}
            className={`relative aspect-square w-full flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${typeStyle.bg}`}
        >
            {category === 'image' ? (
                <FileThumbnail fileId={file.id} alt={file.filename} />
            ) : assetType === 'video' ? (
                <>
                    {/* eslint-disable-next-line @next/next/no-img-element -- a captured data: URI, nothing next/image can optimize */}
                    {videoFrameUrl && <img src={videoFrameUrl} alt={file.filename} className="absolute inset-0 w-full h-full object-cover" />}
                    <div className={`relative h-9 w-9 rounded-full flex items-center justify-center ${videoFrameUrl ? 'bg-black/50' : 'bg-background/80'}`}>
                        <Play className={`w-4 h-4 ml-0.5 ${videoFrameUrl ? 'text-white fill-white' : 'text-foreground/70'}`} />
                    </div>
                </>
            ) : (
                <TypeIcon className={`h-8 w-8 ${typeStyle.icon}`} />
            )}
            {/* Bottom-left, not top-left as in chat: the selection checkbox owns
                that corner here. */}
            <span className="absolute bottom-1.5 left-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-background/90 border border-border/60">
                {TYPE_BADGES[assetType]}
            </span>
        </button>
    );
}

export function FileGridView({
    folderCards, files, selectedFile, onSelectFile, selectedIds, onToggleSelect,
    ingestingFiles, onIngestFile, onIngestFolder, onNavigateToFolder, onPreviewFile, onDownload,
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
                            disabled={fileCount === 0 || fileCount > MAX_ATTACHMENTS_PER_MESSAGE}
                            label={folderChatLabel(fileCount)}
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
                        <FileTileArt file={file} category={category} onPreview={() => onPreviewFile(file.id)} />
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
