"use client";

import { EmptyState, ConfirmDialog } from "@/components/platform/shared";
import {
    Loader2, FolderOpen, ChevronRight, ChevronLeft, MessageSquare, LayoutGrid, List as ListIcon, Play, Trash2
} from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FilesFilter } from "./FilesFilter";
import { stagePendingAttachments } from "@/lib/pendingAttachments";
import { MAX_FILES_PER_SELECTION } from "@/components/platform/chat/useFileUpload";
import { getFileCategory, isIngestibleCategory, isParseable } from "./fileCategory";
import { FileGridView } from "./components/FileGridView";
import { FileListView } from "./components/FileListView";
import { IngestionSidePanel } from "./IngestionSidePanel";
import { useFilesQuery } from "./hooks/useFilesQuery";
import { useFileIngestion } from "./hooks/useFileIngestion";
import { useFileSelection } from "./hooks/useFileSelection";
import { useFileMutations } from "./hooks/useFileMutations";
import { useFileFilters } from "./hooks/useFileFilters";
import type { FileRecord, FolderCard } from "./types";
import type { ConversationsResponse } from "@/components/platform/chat/types";
import { AddToChatMenu } from "./components/AddToChatMenu";
import { AssetLightbox } from "@/components/platform/canvas/AssetLightbox";
import { fileToAsset } from "./lib/assetFromFile";

interface FilesListProps {
    prefix: string;
    onPrefixChange: (prefix: string) => void;
    onUploadClick: () => void;
    canUpload: boolean;
    canDelete: boolean;
    showPipelineDetails?: boolean;
}

export function FilesList({ prefix, onPrefixChange, onUploadClick, canUpload, canDelete, showPipelineDetails = false }: FilesListProps) {
    const params = useParams();
    const router = useRouter();
    const tenant = params.tenant as string;

    const { allFiles, files, virtualFolders, workspaceNames, breadcrumbs, isLoading, defaultAgentId } = useFilesQuery(prefix);
    const ingestion = useFileIngestion({ prefix, onPrefixChange });
    const selection = useFileSelection();
    const mutations = useFileMutations();
    const filters = useFileFilters(files);

    const [selectedFile, setSelectedFile] = useState<FileRecord | null>(null);
    const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
    // Held as an id, not a record, so the lightbox's prev/next can hand back an
    // Asset and still resolve to the row it came from.
    const [previewFileId, setPreviewFileId] = useState<string | null>(null);

    // Same key the chat page uses, so whichever loads first warms the other.
    const { data: conversationsData } = useQuery({
        queryKey: ['conversations'],
        queryFn: () => api.get<ConversationsResponse>('/api/v1/conversations'),
    });
    const conversations = conversationsData?.data ?? [];

    const tooManySelected = selection.selectedIds.size > MAX_FILES_PER_SELECTION;

    // conversationId null opens a new session; otherwise the files land in that
    // existing chat. Either way ChatInput consumes the staged payload on mount,
    // so the destination is just which route we navigate to.
    const addToChat = (chosen: FileRecord[], conversationId: string | null) => {
        if (chosen.length === 0) return;
        if (!conversationId && !defaultAgentId) return;
        stagePendingAttachments(chosen.map(f => ({
            fileId: f.id,
            name: f.filename,
            type: f.contentType,
            size: f.size,
        })));
        router.push(conversationId
            ? `/${tenant}/dashboard/chat?id=${conversationId}`
            : `/${tenant}/dashboard/chat?agentId=${defaultAgentId}`);
    };

    // A folder attaches everything under its prefix, so it obeys the same cap as a
    // multi-select. Large folders want folderId RAG scope instead — but that needs a
    // personFolderId, which prefix-derived folders usually do not have.
    const addFolderToChat = (folderPrefix: string, conversationId: string | null) => {
        addToChat(allFiles.filter(f => f.key.startsWith(folderPrefix)), conversationId);
    };

    const addSelectionToChat = (conversationId: string | null) => {
        if (tooManySelected) return;
        addToChat(allFiles.filter(f => selection.selectedIds.has(f.id)), conversationId);
    };

    const folderCards: FolderCard[] = useMemo(() => virtualFolders.map(folderName => {
        const folderPrefix = `${prefix}${folderName}/`;
        const folderFiles = allFiles.filter(f => f.key.startsWith(folderPrefix));
        const allDone = folderFiles.length > 0 && folderFiles.every(f => f.ingestionStatus === 'done');
        const totalSize = folderFiles.reduce((sum, f) => sum + (f.size ?? 0), 0);
        // Newest file in the folder: a folder's "Added" is when it last gained
        // something, which is what you sort and scan by.
        const latestAddedAt = folderFiles.reduce<string | null>(
            (latest, f) => (!latest || f.createdAt > latest ? f.createdAt : latest), null);
        return {
            folderName, folderPrefix, allDone,
            isIngesting: ingestion.ingestingFolders.has(folderName),
            fileCount: folderFiles.length, totalSize, latestAddedAt,
        };
    }), [virtualFolders, allFiles, prefix, ingestion.ingestingFolders]);

    const { pagedFiles, filteredFiles, totalPages, currentPage, setCurrentPage } = filters;

    // The lightbox arrows walk the page you are looking at, in the order it is
    // displayed — same set the table renders, so nothing scrolls past unseen.
    const pageAssets = useMemo(() => pagedFiles.map(fileToAsset), [pagedFiles]);
    const previewAsset = previewFileId ? pageAssets.find(a => a.id === previewFileId) ?? null : null;
    const allPageSelected = pagedFiles.length > 0 && pagedFiles.every(f => selection.selectedIds.has(f.id));

    const hasParseableFiles = files.some(isParseable);

    const { folderPersonFolderId, folderAllDone } = useMemo(() => {
        if (!prefix) return { folderPersonFolderId: null, folderAllDone: false };
        const inFolder = allFiles.filter(f => f.key.startsWith(prefix));
        const personFolderId = inFolder.find(f => f.personFolderId)?.personFolderId ?? null;
        const ingestibleFiles = inFolder.filter(f => isIngestibleCategory(getFileCategory(f.contentType, f.filename)));
        const allDone = ingestibleFiles.length > 0 && ingestibleFiles.every(f => f.ingestionStatus === 'done');
        return { folderPersonFolderId: personFolderId, folderAllDone: allDone };
    }, [prefix, allFiles]);

    return (
        <div className="space-y-4">
            {/* Breadcrumb — hidden at the root, where it only repeats the page title */}
            <div className={`items-center text-base text-muted-foreground ${prefix ? 'flex' : 'hidden'}`}>
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
                    {folderPersonFolderId && folderAllDone && (
                        <div className="flex items-center justify-between px-4 py-2.5 rounded-lg bg-primary/10 border border-primary/20">
                            {/* text-shimmer-accent, not text-primary: the pale rose --primary
                                fails WCAG AA as body text on the light theme (see globals.css) —
                                --shimmer-accent is the same hue, darkened for readability there,
                                and equal to --primary on the dark theme where it's already legible. */}
                            <div className="flex items-center gap-2 text-sm text-shimmer-accent">
                                <MessageSquare className="w-4 h-4" />
                                <span>These files are ready to work with</span>
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
                    )}
                    <div className="flex items-center justify-between gap-2">
                        {files.length > 0 ? <FilesFilter
                            workspaceNames={workspaceNames} filterWorkspace={filters.filterWorkspace} onWorkspaceChange={filters.onWorkspaceChange}
                            filterClassification={filters.filterClassification} onClassificationChange={filters.onClassificationChange}
                            filterCategory={filters.filterCategory} onCategoryChange={filters.onCategoryChange}
                            filterTimeRange={filters.filterTimeRange} onTimeRangeChange={filters.onTimeRangeChange}
                            showPipelineDetails={showPipelineDetails}
                        /> : <div />}
                        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-secondary border border-border">
                            <Button
                                variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => setViewMode('list')}
                                title="List view"
                            >
                                <ListIcon className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                                variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => setViewMode('grid')}
                                title="Grid view"
                            >
                                <LayoutGrid className="w-3.5 h-3.5" />
                            </Button>
                        </div>
                    </div>
                    {showPipelineDetails && hasParseableFiles && (
                        <div className="flex justify-end">
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs gap-1.5"
                                onClick={() => ingestion.ingestAllInFolder(files)}
                                disabled={ingestion.isIngestingAllInFolder}
                            >
                                {ingestion.isIngestingAllInFolder
                                    ? <Loader2 className="w-3 h-3 animate-spin" />
                                    : <Play className="w-3 h-3" />}
                                {ingestion.isIngestingAllInFolder ? 'Parsing…' : 'Parse All'}
                            </Button>
                        </div>
                    )}
                    {/* Bulk action bar */}
                    {selection.selectedIds.size > 0 && (
                        <div className="flex items-center justify-between px-4 py-2 rounded-lg bg-secondary border border-border text-sm">
                            <span className="text-foreground/80">Selected: <strong>{selection.selectedIds.size}</strong> {selection.selectedIds.size === 1 ? 'file' : 'files'}</span>
                            <div className="flex items-center gap-2">
                                {tooManySelected && (
                                    <span className="text-xs text-muted-foreground">
                                        Up to {MAX_FILES_PER_SELECTION} files per session
                                    </span>
                                )}
                                <AddToChatMenu
                                    variant="bulk"
                                    conversations={conversations}
                                    disabled={tooManySelected || !defaultAgentId}
                                    onPick={addSelectionToChat}
                                />
                                <Button size="sm" variant="destructive" className="h-7 text-xs gap-1" onClick={selection.bulkDelete} disabled={selection.bulkDeleting}>
                                    {selection.bulkDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                                    Delete Selected
                                </Button>
                            </div>
                        </div>
                    )}
                    <div className="flex gap-4 items-start">
                    {viewMode === 'grid' ? (
                        <FileGridView
                            folderCards={folderCards}
                            files={pagedFiles}
                            selectedFile={selectedFile}
                            onSelectFile={setSelectedFile}
                            selectedIds={selection.selectedIds}
                            onToggleSelect={selection.toggleSelect}
                            ingestingFiles={ingestion.ingestingFiles}
                            onIngestFile={ingestion.ingestFile}
                            onIngestFolder={(folderName) => ingestion.ingestFolder(folderName, allFiles)}
                            onNavigateToFolder={onPrefixChange}
                            onPreviewFile={setPreviewFileId}
                            onDownload={mutations.downloadFile}
                            canDelete={canDelete}
                            onDeleteFile={mutations.setDeletingFileId}
                            onDeleteFolder={mutations.setDeletingFolderName}
                            conversations={conversations}
                            onAddToChat={addToChat}
                            onAddFolderToChat={addFolderToChat}
                            showPipelineDetails={showPipelineDetails}
                        />
                    ) : (
                        <FileListView
                            folderCards={folderCards}
                            files={pagedFiles}
                            selectedFile={selectedFile}
                            onSelectFile={setSelectedFile}
                            selectedIds={selection.selectedIds}
                            onToggleSelect={selection.toggleSelect}
                            allPageSelected={allPageSelected}
                            onToggleSelectAll={() => selection.toggleSelectAll(pagedFiles.map(f => f.id))}
                            ingestingFiles={ingestion.ingestingFiles}
                            onIngestFile={ingestion.ingestFile}
                            onIngestFolder={(folderName) => ingestion.ingestFolder(folderName, allFiles)}
                            onNavigateToFolder={onPrefixChange}
                            onPreviewFile={setPreviewFileId}
                            onDownload={mutations.downloadFile}
                            canDelete={canDelete}
                            onDeleteFile={mutations.setDeletingFileId}
                            onDeleteFolder={mutations.setDeletingFolderName}
                            conversations={conversations}
                            onAddToChat={addToChat}
                            onAddFolderToChat={addFolderToChat}
                            showPipelineDetails={showPipelineDetails}
                        />
                    )}

                    {/* Side panel — pipeline lineage only, so it follows the same flag */}
                    {showPipelineDetails && selectedFile && (
                        <IngestionSidePanel file={selectedFile} onClose={() => setSelectedFile(null)} />
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

            {/* Same viewer the chat canvas uses, so a file plays the same way
                wherever you open it from. */}
            {previewAsset && (
                <AssetLightbox
                    asset={previewAsset}
                    allAssets={pageAssets}
                    onClose={() => setPreviewFileId(null)}
                    onNavigate={(next) => setPreviewFileId(next.id)}
                />
            )}

            <ConfirmDialog
                open={!!mutations.deletingFileId}
                onOpenChange={(open) => !open && mutations.setDeletingFileId(null)}
                title="Delete Document"
                description="Are you sure you want to permanently delete this document? This action cannot be undone."
                confirmLabel="Delete"
                variant="danger"
                onConfirm={() => { if (mutations.deletingFileId) mutations.deleteMutation.mutate(mutations.deletingFileId); }}
                loading={mutations.deleteMutation.isPending}
            />

            <ConfirmDialog
                open={!!mutations.deletingFolderName}
                onOpenChange={(open) => !open && mutations.setDeletingFolderName(null)}
                title="Delete Folder"
                description={`Delete folder "${mutations.deletingFolderName}" and all its files? This cannot be undone.`}
                confirmLabel="Delete Folder"
                variant="danger"
                onConfirm={() => { if (mutations.deletingFolderName) mutations.deleteFolder(mutations.deletingFolderName, prefix, allFiles); }}
                loading={mutations.deletingFolder}
            />
        </div>
    );
}
