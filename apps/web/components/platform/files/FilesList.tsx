"use client";

import { EmptyState, ConfirmDialog } from "@/components/platform/shared";
import {
    Loader2, FolderOpen, ChevronRight, ChevronLeft, MessageSquare, LayoutGrid, List as ListIcon, Play, Trash2, Search
} from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FilesFilter } from "./FilesFilter";
import { stagePendingAttachments } from "@/lib/pendingAttachments";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@/components/platform/chat/useFileUpload";
import { getFileCategory, isIngestibleCategory, isParseable } from "./fileCategory";
import { SYSTEM_FOLDER_LABELS, PILL_FOLDERS, isSystemFolder, uploadsWithOrphanProductFiles, withProductsPill } from "./systemFolders";
import { DriveProducts } from "./DriveProducts";
import { listProductImageFileIds } from "@/components/platform/chat/creative-library/productsApi";
import type { Attachment } from "@/types/agent-events";
import { FileGridView } from "./components/FileGridView";
import { FileListView } from "./components/FileListView";
import { IngestionSidePanel } from "./IngestionSidePanel";
import { useFilesQuery } from "./hooks/useFilesQuery";
import { useFileIngestion } from "./hooks/useFileIngestion";
import { useFileSelection } from "./hooks/useFileSelection";
import { useFileMutations } from "./hooks/useFileMutations";
import { useFileFilters } from "./hooks/useFileFilters";
import { useStorageUsage } from "./hooks/useStorageUsage";
import { StorageMeter, shouldShowMeter } from "./components/StorageMeter";
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
    const queryClient = useQueryClient();

    const { allFiles, files, virtualFolders, workspaceNames, breadcrumbs, isLoading, defaultAgentId } = useFilesQuery(prefix);
    const ingestion = useFileIngestion({ prefix, onPrefixChange });
    const selection = useFileSelection();
    const mutations = useFileMutations();
    const storageUsage = useStorageUsage();

    const [selectedFile, setSelectedFile] = useState<FileRecord | null>(null);
    const [viewMode, setViewMode] = useState<'list' | 'grid'>('grid');
    // Held as an id, not a record, so the lightbox's prev/next can hand back an
    // Asset and still resolve to the row it came from.
    const [previewFileId, setPreviewFileId] = useState<string | null>(null);

    // Same key the chat page uses, so whichever loads first warms the other.
    const { data: conversationsData } = useQuery({
        queryKey: ['conversations'],
        queryFn: () => api.get<ConversationsResponse>('/api/v1/conversations'),
    });
    const conversations = conversationsData?.data ?? [];

    // The product panel's mutations invalidate ['creative-products'], which
    // refreshes this too.
    const { data: productImageIds } = useQuery({ queryKey: ['creative-products', '__image-file-ids'], queryFn: listProductImageFileIds });
    const referencedProductImageIds = useMemo(() => productImageIds ? new Set(productImageIds) : null, [productImageIds]);

    const tooManySelected = selection.selectedIds.size > MAX_ATTACHMENTS_PER_MESSAGE;

    // conversationId null opens a new session; otherwise the files land in that
    // existing chat. Either way ChatInput consumes the staged payload on mount,
    // so the destination is just which route we navigate to. A new session opens
    // the empty composer rather than creating a conversation up front, which
    // left an untitled chat behind on every click that never sent anything.
    const addAttachmentsToChat = (attachments: Attachment[], conversationId: string | null) => {
        if (attachments.length === 0) return;
        stagePendingAttachments(attachments);
        router.push(conversationId
            ? `/${tenant}/dashboard/chat?id=${conversationId}`
            : `/${tenant}/dashboard/chat`);
    };

    const addToChat = (chosen: FileRecord[], conversationId: string | null) => {
        addAttachmentsToChat(chosen.map(f => ({
            fileId: f.id,
            name: f.filename,
            type: f.contentType,
            size: f.size,
        })), conversationId);
    };

    // A folder is granted, not attached. Attaching pushed every file's bytes into
    // context and capped the feature at whatever the composer would carry; a grant
    // hands the agent a handle, and it lists and reads on demand. That is why a
    // folder of any size now works where one of six did not.
    //
    // An existing conversation is granted directly. A new one does not exist yet,
    // so the prefix rides the URL and the chat page grants it once the conversation
    // has been created.
    const grantFolderToChat = async (folderPrefix: string, conversationId: string | null) => {
        if (!conversationId) {
            if (!defaultAgentId) return;
            router.push(`/${tenant}/dashboard/chat?agentId=${defaultAgentId}&grantFolder=${encodeURIComponent(folderPrefix)}`);
            return;
        }
        try {
            await api.patch(`/api/v1/conversations/${conversationId}`, { folderScope: { prefix: folderPrefix } });
            queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
            queryClient.invalidateQueries({ queryKey: ['conversations'] });
            router.push(`/${tenant}/dashboard/chat?id=${conversationId}`);
        } catch {
            toast.error('Could not grant folder access');
        }
    };

    const addSelectionToChat = (conversationId: string | null) => {
        if (tooManySelected) return;
        addToChat(allFiles.filter(f => selection.selectedIds.has(f.id)), conversationId);
    };

    // System-managed prefixes (chat uploads, creative library, generated media)
    // surface as pills, not folder tiles — an empty-looking "generated/" card
    // conveyed nothing a pill can't say better. Folder tiles are only hidden at
    // the root: a same-named folder nested inside a real user folder is just a
    // folder. The pill list is remembered from the root listing, because inside
    // a folder virtualFolders holds that folder's children, not the root's —
    // without this the tabs vanished as soon as one was clicked.
    // "Uploads" is a view over the whole listing (every file that is not agent
    // output or creative library), not a folder, so it can't be expressed as a
    // prefix.
    const [uploadsActive, setUploadsActive] = useState(false);
    const uploads = uploadsActive && !prefix;
    const navigate = (nextPrefix: string) => { setUploadsActive(false); onPrefixChange(nextPrefix); };
    const uploadFiles = useMemo(
        () => uploadsWithOrphanProductFiles(allFiles, referencedProductImageIds).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        [allFiles, referencedProductImageIds]);
    // "All" at the top level is every file that is not inside one of the user's
    // own folders (those open from their tiles), newest first — not just the
    // few loose ones, which hid chat uploads, generated files and the library.
    const topLevelFiles = useMemo(
        () => allFiles
            .filter(f => { const [first, ...rest] = f.key.split('/'); return rest.length === 0 || isSystemFolder(first); })
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        [allFiles]);
    const shownFiles = uploads ? uploadFiles : !prefix ? topLevelFiles : files;
    const shownFolderCount = uploads ? 0 : virtualFolders.length;

    const [rootSystemFolders, setRootSystemFolders] = useState<string[]>([]);
    if (!prefix && !isLoading) {
        const fresh = virtualFolders.filter(name => (PILL_FOLDERS as readonly string[]).includes(name));
        if (fresh.join('|') !== rootSystemFolders.join('|')) setRootSystemFolders(fresh);
    }
    const currentSystemFolder = prefix ? prefix.split('/')[0] : null;
    // Opened straight into a folder, so the root was never loaded: show all four
    // rather than only the current one. A folder's pill is also kept when it was
    // missing from an earlier root load (e.g. its first file was just uploaded).
    const systemFolderPills = withProductsPill(rootSystemFolders.length === 0 && prefix
        ? [...PILL_FOLDERS]
        : currentSystemFolder && (PILL_FOLDERS as readonly string[]).includes(currentSystemFolder) && !rootSystemFolders.includes(currentSystemFolder)
            ? [...rootSystemFolders, currentSystemFolder]
            : rootSystemFolders);
    // Inside one of the user's own folders no system pill matches, so "All" is
    // the active one — the folder lives under it.
    const activeSystemFolder = currentSystemFolder && (PILL_FOLDERS as readonly string[]).includes(currentSystemFolder) ? currentSystemFolder : null;

    const allFolderCards: FolderCard[] = useMemo(() => (uploads ? [] : virtualFolders)
        .filter(folderName => prefix || !isSystemFolder(folderName))
        .map(folderName => {
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
            previewFiles: [...folderFiles]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .slice(0, 3),
        };
    }), [virtualFolders, allFiles, prefix, uploads, ingestion.ingestingFolders]);

    // Folders share the page budget with files, so the hook needs their count.
    const filters = useFileFilters(shownFiles, allFolderCards.length);
    const { pagedFiles, filteredFiles, totalPages, currentPage, setCurrentPage, folderRange } = filters;
    const folderCards = useMemo(
        () => allFolderCards.slice(folderRange.start, folderRange.end),
        [allFolderCards, folderRange.start, folderRange.end]);

    // The lightbox arrows walk the page you are looking at, in the order it is
    // displayed — same set the table renders, so nothing scrolls past unseen.
    const pageAssets = useMemo(() => pagedFiles.map(fileToAsset), [pagedFiles]);
    const previewAsset = previewFileId ? pageAssets.find(a => a.id === previewFileId) ?? null : null;
    // The lightbox works in Assets, but Add to chat stages a FileRecord.
    const previewFile = previewFileId ? pagedFiles.find(f => f.id === previewFileId) ?? null : null;
    const allPageSelected = pagedFiles.length > 0 && pagedFiles.every(f => selection.selectedIds.has(f.id));

    const hasParseableFiles = shownFiles.some(isParseable);

    const { folderPersonFolderId, folderAllDone } = useMemo(() => {
        if (!prefix) return { folderPersonFolderId: null, folderAllDone: false };
        const inFolder = allFiles.filter(f => f.key.startsWith(prefix));
        const personFolderId = inFolder.find(f => f.personFolderId)?.personFolderId ?? null;
        const ingestibleFiles = inFolder.filter(f => isIngestibleCategory(getFileCategory(f.contentType, f.filename)));
        const allDone = ingestibleFiles.length > 0 && ingestibleFiles.every(f => f.ingestionStatus === 'done');
        return { folderPersonFolderId: personFolderId, folderAllDone: allDone };
    }, [prefix, allFiles]);

    // Below the pill/search toolbar, right above the grid — not at the very
    // top, where it used to sit above the toolbar itself. Rendered from both
    // branches below so navigating back out of an empty folder still works.
    const breadcrumbNav = prefix && (
        <div className="flex items-center text-base text-muted-foreground">
            <button onClick={() => navigate("")} className="hover:text-foreground transition-colors">
                Drive
            </button>
            {breadcrumbs.map((crumb, idx) => (
                <div key={crumb.path} className="flex items-center">
                    <ChevronRight className="w-4 h-4 mx-1 opacity-50" />
                    <button onClick={() => navigate(crumb.path)} className={`hover:text-foreground transition-colors ${idx === breadcrumbs.length - 1 ? 'text-foreground font-medium' : ''}`}>
                        {idx === 0 ? (SYSTEM_FOLDER_LABELS[crumb.name] ?? crumb.name) : crumb.name}
                    </button>
                </div>
            ))}
        </div>
    );

    return (
        <div className="space-y-4">
            {/* Outside the loading/empty branches below, and above the folder
                contents: a tenant near their ceiling should see it whichever
                folder they happen to be standing in, including an empty one. */}
            {storageUsage && shouldShowMeter(storageUsage) && (
                <StorageMeter
                    percent={storageUsage.percent}
                    usedBytes={storageUsage.usedBytes}
                    limitBytes={storageUsage.limitBytes}
                />
            )}

                {(
                    <div className="flex gap-1 rounded-full bg-muted p-1 w-fit flex-wrap">
                        <button
                            type="button"
                            onClick={() => navigate("")}
                            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${!activeSystemFolder && !uploads ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}
                        >
                            All
                        </button>
                        <button
                            type="button"
                            onClick={() => { onPrefixChange(""); setUploadsActive(true); }}
                            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${uploads ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}
                        >
                            Uploads
                        </button>
                        {systemFolderPills.map(folderName => (
                            <button
                                key={folderName}
                                type="button"
                                onClick={() => navigate(`${folderName}/`)}
                                className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${activeSystemFolder === folderName ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}
                            >
                                {SYSTEM_FOLDER_LABELS[folderName]}
                            </button>
                        ))}
                    </div>
                )}

            {isLoading && activeSystemFolder !== 'creative-products' ? (
                <div className="flex justify-center py-12 flex-col items-center gap-4 text-muted-foreground border border-border rounded-lg bg-card">
                    <Loader2 className="w-8 h-8 animate-spin" />
                    <p>Loading documents...</p>
                </div>
            ) : activeSystemFolder !== 'creative-products' && shownFiles.length === 0 && shownFolderCount === 0 ? (
                <div className="space-y-4">
                    {breadcrumbNav}
                    <div className="py-8">
                        <EmptyState
                            icon={<FolderOpen className="w-12 h-12" />}
                            title={prefix ? "This folder is empty" : "No files yet"}
                            description="Upload files to begin."
                            action={canUpload ? { label: "Upload", onClick: onUploadClick } : undefined}
                        />
                    </div>
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
                                // Only scope when there is a real id: prefix-derived folders
                                // usually have no personFolderId, and emitting the literal
                                // "null" made retrieveChunks throw for the whole conversation.
                                onClick={() => defaultAgentId && router.push(
                                    `/${tenant}/dashboard/chat?agentId=${defaultAgentId}`
                                    + (folderPersonFolderId ? `&folderId=${folderPersonFolderId}` : '')
                                )}
                            >
                                <MessageSquare className="w-3 h-3" />
                                Chat with Agent
                            </Button>
                        </div>
                    )}
                    {activeSystemFolder !== 'creative-products' && (
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                            <div className="relative flex-1 max-w-md">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                <input
                                    type="text"
                                    value={filters.search}
                                    onChange={e => filters.onSearchChange(e.target.value)}
                                    placeholder="Search files..."
                                    className="w-full h-9 pl-9 pr-3 text-sm rounded-lg bg-secondary border border-border placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                                />
                            </div>
                            {shownFiles.length > 0 && <FilesFilter
                                workspaceNames={workspaceNames} filterWorkspace={filters.filterWorkspace} onWorkspaceChange={filters.onWorkspaceChange}
                                filterClassification={filters.filterClassification} onClassificationChange={filters.onClassificationChange}
                                filterCategory={filters.filterCategory} onCategoryChange={filters.onCategoryChange}
                                filterTimeRange={filters.filterTimeRange} onTimeRangeChange={filters.onTimeRangeChange}
                                showPipelineDetails={showPipelineDetails}
                            />}
                        </div>
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
                    )}
                    {breadcrumbNav}
                    {showPipelineDetails && hasParseableFiles && (
                        <div className="flex justify-end">
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs gap-1.5"
                                onClick={() => ingestion.ingestAllInFolder(shownFiles)}
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
                        <div className="flex items-center justify-between py-1 text-sm">
                            <span className="text-foreground/80">Selected: <strong>{selection.selectedIds.size}</strong> {selection.selectedIds.size === 1 ? 'file' : 'files'}</span>
                            <div className="flex items-center gap-2">
                                {tooManySelected && (
                                    <span className="text-xs text-muted-foreground">
                                        Up to {MAX_ATTACHMENTS_PER_MESSAGE} files per session
                                    </span>
                                )}
                                <AddToChatMenu
                                    variant="bulk"
                                    conversations={conversations}
                                    disabled={tooManySelected || !defaultAgentId}
                                    onPick={addSelectionToChat}
                                />
                                <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={selection.bulkDelete} disabled={selection.bulkDeleting}>
                                    {selection.bulkDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                                    Delete Selected
                                </Button>
                            </div>
                        </div>
                    )}
                    <div className="flex gap-4 items-start">
                    {activeSystemFolder === 'creative-products' ? (
                        <DriveProducts
                            conversations={conversations}
                            canAddToChat={!!defaultAgentId}
                            onAddToChat={addAttachmentsToChat}
                            onDownload={mutations.downloadFile}
                        />
                    ) : viewMode === 'grid' ? (
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
                            onNavigateToFolder={navigate}
                            onPreviewFile={setPreviewFileId}
                            onDownload={mutations.downloadFile}
                            canDelete={canDelete}
                            onDeleteFile={mutations.setDeletingFileId}
                            onDeleteFolder={mutations.setDeletingFolderName}
                            conversations={conversations}
                            onAddToChat={addToChat}
                            onAddFolderToChat={grantFolderToChat}
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
                            onNavigateToFolder={navigate}
                            onPreviewFile={setPreviewFileId}
                            onDownload={mutations.downloadFile}
                            canDelete={canDelete}
                            onDeleteFile={mutations.setDeletingFileId}
                            onDeleteFolder={mutations.setDeletingFolderName}
                            conversations={conversations}
                            onAddToChat={addToChat}
                            onAddFolderToChat={grantFolderToChat}
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
                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setCurrentPage(Math.max(1, currentPage - 1))} disabled={currentPage === 1}>
                                    <ChevronLeft className="w-4 h-4" />
                                </Button>
                                {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                                    <Button key={page} variant={page === currentPage ? "secondary" : "ghost"} size="icon" className="h-7 w-7 text-xs" onClick={() => setCurrentPage(page)}>
                                        {page}
                                    </Button>
                                ))}
                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))} disabled={currentPage === totalPages}>
                                    <ChevronRight className="w-4 h-4" />
                                </Button>
                            </div>
                            <span className="text-xs text-muted-foreground/70">
                                {allFolderCards.length > 0
                                    ? `Total ${allFolderCards.length} ${allFolderCards.length === 1 ? 'folder' : 'folders'}, ${filteredFiles.length} files`
                                    : `Total ${filteredFiles.length} files`}
                            </span>
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
                    headerActions={previewFile && (
                        <AddToChatMenu
                            conversations={conversations}
                            disabled={!defaultAgentId}
                            onPick={(conversationId) => addToChat([previewFile], conversationId)}
                        />
                    )}
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
