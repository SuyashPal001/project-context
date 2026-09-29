"use client";

import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ImagePlus, Loader2, MoreHorizontal, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { FileThumbnail } from '@/components/platform/files/FileThumbnail';
import { cn } from '@/lib/utils';
import type { ProductRecordSelection, ProductSelection } from './creativeBriefModel';
import { storeCreativeImage } from './storeCreativeImage';
import { ProductSetupModal, type ProductSetupSubmission } from './ProductSetupModal';
import {
    PRODUCTS_PAGE_SIZE, createProduct, createProductFromFiles, deleteProduct, describeProduct, importProductFromUrl,
    listProducts, productSelection, renameProduct, updateProduct, type ProductRecord,
} from './productsApi';

const PRODUCT_PREFIX = 'creative-products/';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 35 * 1024 * 1024;
const DELETE_UNDO_MS = 5000;
const LINK_FAILED = "Couldn't read this page. Drop a product photo instead.";
const SEARCH_DEBOUNCE_MS = 250;
const STALE_PENDING_MS = 30_000;

export function ProductsPanel({ selected, onSelect, onProductNamed, onOpen, hideHeading, emptyHint }: {
    selected: ProductSelection | null;
    onSelect: (selection: ProductSelection) => void;
    /**
     * Reports a product whose AI name finished, independent of what the panel
     * itself has selected — the panel is only mounted while the Products tab
     * is open, so naming that completes after the user has moved on (or sent
     * the message) must still reach the brief. The caller decides whether
     * this still matches the current brief selection; the panel doesn't guard
     * it (see F1 in the products-library final-fix brief).
     */
    onProductNamed?: (product: ProductRecordSelection) => void;
    /** When set, clicking a card calls this instead of selecting the product. */
    onOpen?: (product: ProductRecord) => void;
    /** Hides the "Products" heading; the search box still renders. */
    hideHeading?: boolean;
    /** Replaces the default first-visit hint line. */
    emptyHint?: string;
}) {
    const queryClient = useQueryClient();
    const inputRef = useRef<HTMLInputElement>(null);
    const mountedRef = useRef(true);
    const selectedIdRef = useRef<string | null>(null);
    const pendingDeletes = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const staleNamingAttempted = useRef(new Set<string>());
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [link, setLink] = useState('');
    const [busy, setBusy] = useState<'link' | 'photos' | null>(null);
    const [linkError, setLinkError] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);
    const [hidden, setHidden] = useState<Set<string>>(() => new Set());
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
    const photoPreviewUrlRef = useRef<string | null>(null);
    const [setupOpen, setSetupOpen] = useState(false);
    // The product being edited via the setup modal — null in create mode
    // (blank form), a record in edit mode (prefilled). Ignored while
    // setupOpen is false; not reset on close, so the closed modal doesn't
    // flash blank before its next open re-seeds it.
    const [setupProduct, setSetupProduct] = useState<ProductRecord | null>(null);
    selectedIdRef.current = selected?.kind === 'product' ? selected.id : null;

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [search]);

    const { data, isPending, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
        queryKey: ['creative-products', debouncedSearch.trim()],
        initialPageParam: 0,
        queryFn: ({ pageParam }) => listProducts(debouncedSearch, pageParam),
        getNextPageParam: (last, pages) => last.data.length === PRODUCTS_PAGE_SIZE ? pages.length * PRODUCTS_PAGE_SIZE : undefined,
        placeholderData: keepPreviousData,
    });
    const products = (data?.pages.flatMap(page => page.data) ?? []).filter(product => !hidden.has(product.id));
    const isEmpty = !isPending && !isError && products.length === 0 && !search.trim();

    // F1(b): if naming finished, or any field changed (elsewhere — a
    // different tab, or this same edit landing after the tab was left and
    // rejoined) while this panel wasn't mounted to hear it directly,
    // reconcile the currently selected product from the freshly loaded
    // list. Guarded on an actual difference so this can't loop against the
    // onSelect it triggers.
    useEffect(() => {
        if (selected?.kind !== 'product') return;
        const match = products.find(product => product.id === selected.id);
        if (!match) return;
        const unchanged = match.name === selected.name && match.namingStatus === selected.namingStatus
            && match.category === selected.category && match.description === selected.description
            && JSON.stringify(match.usps) === JSON.stringify(selected.usps);
        if (unchanged) return;
        onSelect(productSelection(match));
    }, [products, selected, onSelect]);

    // F6: a product can be left `pending` forever if the original describe
    // call failed silently (network blip, cold gateway). Once per mounted
    // session, retry naming for any pending product old enough that the
    // normal in-flight describe (kicked off right after creation) must have
    // already finished or failed.
    useEffect(() => {
        const now = Date.now();
        for (const product of products) {
            if (product.namingStatus !== 'pending') continue;
            if (staleNamingAttempted.current.has(product.id)) continue;
            if (now - new Date(product.createdAt).getTime() < STALE_PENDING_MS) continue;
            staleNamingAttempted.current.add(product.id);
            void nameIfPending(product);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- nameIfPending is stable enough here; including it would re-run this on every render since it closes over onProductNamed/refresh.
    }, [products]);

    useEffect(() => {
        mountedRef.current = true;
        const deletes = pendingDeletes.current;
        return () => {
            mountedRef.current = false;
            // Leaving the panel commits any delete still inside its undo window. The
            // toasts for those deletes are dismissed too, so a lingering Undo button
            // can't report a restore that no longer happens.
            for (const [id, timer] of deletes) {
                clearTimeout(timer);
                toast.dismiss(id);
                void deleteProduct(id).then(() => queryClient.invalidateQueries({ queryKey: ['creative-products'] })).catch(() => {});
            }
            deletes.clear();
            if (photoPreviewUrlRef.current) URL.revokeObjectURL(photoPreviewUrlRef.current);
        };
    }, []);

    const refresh = () => queryClient.invalidateQueries({ queryKey: ['creative-products'] });
    const unhide = (id: string) => setHidden(prev => { const next = new Set(prev); next.delete(id); return next; });

    async function nameIfPending(product: ProductRecord) {
        if (product.namingStatus !== 'pending') return;
        try {
            const named = await describeProduct(product.id);
            // No mountedRef/selectedIdRef guard here: the panel only mounts while
            // the Products tab is open, so a guard here would drop the AI name
            // whenever the user switches tabs or sends before it resolves. The
            // caller (the chat page) decides whether this still matches the
            // brief's current product selection.
            onProductNamed?.(productSelection(named));
        } catch {
            // Naming failed: the card and brief keep the placeholder; Olmo asks.
        } finally {
            await refresh();
        }
    }

    async function addPhotos(fileList: FileList | File[]) {
        const files = Array.from(fileList);
        if (files.length === 0 || busy) return;
        if (files.length > MAX_PHOTOS) { toast.error(`Add up to ${MAX_PHOTOS} photos of one product at a time.`); return; }
        if (files.some(file => !IMAGE_TYPES.has(file.type))) { toast.error('Choose JPG, PNG, or WebP images.'); return; }
        if (files.some(file => file.size > MAX_PHOTO_BYTES)) { toast.error('Product images must be under 35 MB.'); return; }
        const previewUrl = URL.createObjectURL(files[0]);
        photoPreviewUrlRef.current = previewUrl;
        setPhotoPreviewUrl(previewUrl);
        setBusy('photos');
        setLinkError(null);
        try {
            const attachments = await Promise.all(files.map(file => storeCreativeImage(file, PRODUCT_PREFIX)));
            const product = await createProductFromFiles(attachments.map(attachment => attachment.fileId));
            await refresh();
            if (!mountedRef.current) return;
            selectedIdRef.current = product.id;
            onSelect(productSelection(product));
            void nameIfPending(product);
        } catch {
            if (mountedRef.current) toast.error('Could not add the product photos. Please try again.');
        } finally {
            if (mountedRef.current) setBusy(null);
            URL.revokeObjectURL(previewUrl);
            photoPreviewUrlRef.current = null;
            if (mountedRef.current) setPhotoPreviewUrl(null);
        }
    }

    async function addLink(raw: string) {
        if (busy) return;
        let parsed: URL;
        try {
            parsed = new URL(raw.trim());
            if (parsed.protocol !== 'https:') throw new Error('Invalid protocol');
        } catch {
            setLinkError('Enter a product link that starts with https://');
            return;
        }
        setBusy('link');
        setLinkError(null);
        try {
            const product = await importProductFromUrl(parsed.href);
            await refresh();
            if (!mountedRef.current) return;
            setLink('');
            selectedIdRef.current = product.id;
            onSelect(productSelection(product));
            void nameIfPending(product);
        } catch {
            if (mountedRef.current) setLinkError(LINK_FAILED);
        } finally {
            if (mountedRef.current) setBusy(null);
        }
    }

    function onPasteLink(event: ClipboardEvent<HTMLInputElement>) {
        const text = event.clipboardData.getData('text').trim();
        if (!text.startsWith('https://')) return;
        event.preventDefault();
        setLink(text);
        void addLink(text);
    }

    async function commitRename(product: ProductRecord) {
        const name = renameValue.trim().slice(0, 120);
        setRenamingId(null);
        if (!name || name === product.name) return;
        try {
            const updated = await renameProduct(product.id, name);
            if (selectedIdRef.current === updated.id) onSelect(productSelection(updated));
            await refresh();
        } catch {
            toast.error('Could not rename the product.');
        }
    }

    async function handleSetupSave(fields: ProductSetupSubmission) {
        try {
            const saved = setupProduct
                // Only send `name` when it actually changed — updateProduct finalizes
                // namingStatus to 'done' whenever `name` is present, so resending the
                // unchanged name on a category/description/usps-only edit would lock in
                // "Untitled product" (or an AI-generated name) while naming is still
                // pending, throwing away the real name once it lands.
                ? await updateProduct(setupProduct.id, { ...fields, name: fields.name !== setupProduct.name ? fields.name : undefined })
                : await createProduct(fields);
            await refresh();
            if (!mountedRef.current) return;
            if (!setupProduct) selectedIdRef.current = saved.id;
            if (selectedIdRef.current === saved.id) onSelect(productSelection(saved));
            setSetupOpen(false);
        } catch {
            toast.error(setupProduct ? 'Could not update the product.' : 'Could not create the product.');
        }
    }

    function removeProduct(product: ProductRecord) {
        setHidden(prev => new Set(prev).add(product.id));
        const timer = setTimeout(() => {
            pendingDeletes.current.delete(product.id);
            toast.dismiss(product.id);
            deleteProduct(product.id).then(refresh).catch(() => {
                if (!mountedRef.current) return;
                unhide(product.id);
                toast.error('Could not delete the product.');
            });
        }, DELETE_UNDO_MS);
        pendingDeletes.current.set(product.id, timer);
        // A fixed id lets the unmount cleanup and the timer above dismiss this exact
        // toast; an explicit duration matching the undo window keeps sonner's own
        // default (~4s) from hiding Undo before the delete actually commits.
        toast.success('Product deleted', {
            id: product.id,
            duration: DELETE_UNDO_MS,
            action: { label: 'Undo', onClick: () => { clearTimeout(timer); pendingDeletes.current.delete(product.id); unhide(product.id); } },
        });
    }

    return <div className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {!hideHeading && <h2 className="text-xl font-semibold tracking-tight text-foreground">Products</h2>}
            <div className="flex w-full items-center gap-2 sm:w-auto">
                {!isEmpty && <div className="relative w-full sm:w-64">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search products" aria-label="Search products" className="h-9 pl-9" />
                </div>}
                <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => { setSetupProduct(null); setSetupOpen(true); }}>
                    <Plus className="mr-1 h-4 w-4" />New product
                </Button>
            </div>
        </div>
        <div
            data-testid="product-drop-zone"
            onDragOver={event => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={event => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length) void addPhotos(event.dataTransfer.files); }}
            className={cn('space-y-3 rounded-xl border border-dashed p-4 transition-colors', dragging ? 'border-foreground bg-muted' : 'border-border')}
        >
            <p className="text-sm font-medium text-foreground">Paste a product link or drop photos</p>
            <form onSubmit={event => { event.preventDefault(); void addLink(link); }} className="flex gap-2">
                <Input type="url" value={link} onChange={event => { setLink(event.target.value); setLinkError(null); }} onPaste={onPasteLink}
                    placeholder="https://your-store.com/product" aria-label="Product link" className="h-10 min-w-0" disabled={busy !== null} />
                <Button type="submit" disabled={!link.trim() || busy !== null} className="shrink-0">
                    {busy === 'link' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Add
                </Button>
                <Button type="button" variant="outline" disabled={busy !== null} onClick={() => inputRef.current?.click()} className="shrink-0">
                    {busy === 'photos' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ImagePlus className="mr-2 h-4 w-4" />}Photos
                </Button>
            </form>
            {linkError && <p role="alert" className="text-xs text-destructive">{linkError}</p>}
            {isEmpty && <p className="text-xs text-muted-foreground">{emptyHint ?? 'You can skip this. Olmo will ask about your product in chat.'}</p>}
            <input ref={inputRef} type="file" multiple accept="image/jpeg,image/png,image/webp" className="hidden" aria-label="Upload product photos"
                onChange={event => { const files = event.target.files; if (files?.length) void addPhotos(files); event.target.value = ''; }} />
        </div>
        {isPending ? <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div> :
            isError ? <div className="py-10 text-center text-sm text-muted-foreground">Could not load products. <Button variant="link" onClick={() => void refetch()}>Retry</Button></div> :
                products.length === 0 && !busy ? (search.trim() ? <p className="py-10 text-center text-sm text-muted-foreground">No products match your search.</p> : null) :
                    <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3">
                        {busy && <div className="min-w-0" aria-live="polite">
                            <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-xl border border-border bg-muted">
                                {busy === 'photos' && photoPreviewUrl
                                    // eslint-disable-next-line @next/next/no-img-element -- local blob preview, not a next/image asset
                                    ? <img src={photoPreviewUrl} alt="" className="h-full w-full object-cover" />
                                    : <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
                            </div>
                            <span className="mt-2 block text-sm text-muted-foreground">{busy === 'photos' ? 'Naming…' : 'Adding…'}</span>
                        </div>}
                        {products.map(product => <ProductCard
                            key={product.id}
                            product={product}
                            selected={selected?.kind === 'product' && selected.id === product.id}
                            renaming={renamingId === product.id}
                            renameValue={renameValue}
                            useLabel={onOpen ? 'Open' : 'Use'}
                            onRenameChange={setRenameValue}
                            onRenameCommit={() => void commitRename(product)}
                            onRenameCancel={() => { setRenameValue(product.name); setRenamingId(null); }}
                            onStartRename={() => { setRenameValue(product.name); setRenamingId(product.id); }}
                            onEdit={() => { setSetupProduct(product); setSetupOpen(true); }}
                            onDelete={() => removeProduct(product)}
                            onUse={() => {
                                if (onOpen) { onOpen(product); return; }
                                selectedIdRef.current = product.id;
                                onSelect(productSelection(product));
                            }}
                        />)}
                    </div>}
        {hasNextPage && <div className="flex justify-center"><Button variant="outline" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>{isFetchingNextPage ? 'Loading…' : 'Load more products'}</Button></div>}
        <ProductSetupModal open={setupOpen} onOpenChange={setSetupOpen} product={setupProduct} onSave={handleSetupSave} />
    </div>;
}

function ProductCard({ product, selected, renaming, renameValue, useLabel, onRenameChange, onRenameCommit, onRenameCancel, onStartRename, onEdit, onDelete, onUse }: {
    product: ProductRecord; selected: boolean; renaming: boolean; renameValue: string; useLabel: string;
    onRenameChange: (value: string) => void; onRenameCommit: () => void; onRenameCancel: () => void;
    onStartRename: () => void; onEdit: () => void; onDelete: () => void; onUse: () => void;
}) {
    const renameRequested = useRef(false);
    const main = product.images[0];
    const pending = product.namingStatus === 'pending';
    const label = pending ? 'Naming…' : product.name;
    return <div className="group min-w-0">
        <button type="button" aria-pressed={selected} aria-label={`${useLabel} ${product.name}`} onClick={onUse}
            className="block w-full rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <div className={cn('relative aspect-square overflow-hidden rounded-xl border bg-muted transition-colors group-hover:border-foreground/50', selected ? 'border-foreground ring-2 ring-foreground/20' : 'border-border')}>
                {main && <FileThumbnail fileId={main.fileId} alt="" />}
                {selected && <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-foreground text-background"><Check className="h-3.5 w-3.5" /></span>}
            </div>
        </button>
        <div className="mt-2 flex min-w-0 items-center gap-1">
            {renaming
                ? <Input autoFocus value={renameValue} maxLength={120} aria-label="Product name" className="h-8"
                    onChange={event => onRenameChange(event.target.value)} onBlur={onRenameCommit}
                    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onRenameCommit(); } if (event.key === 'Escape') onRenameCancel(); }} />
                : <span className={cn('min-w-0 flex-1 truncate text-sm font-semibold', pending ? 'text-muted-foreground' : 'text-foreground')} title={label}>{label}</span>}
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={`More options for ${product.name}`}><MoreHorizontal className="h-4 w-4" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    align="end"
                    onCloseAutoFocus={event => {
                        // Radix returns focus to the trigger when the content unmounts (after its
                        // exit animation), not synchronously on select. Entering rename mode inside
                        // onSelect (immediately or via any fixed delay) races that restore step — it
                        // can steal focus back off the autoFocus rename input and fire its onBlur
                        // commit before the user types anything. Hooking the menu's own
                        // onCloseAutoFocus is the deterministic point Radix actually gives us for
                        // "run this after the menu has fully closed and would otherwise refocus the
                        // trigger": prevent that default refocus and start renaming instead.
                        if (renameRequested.current) {
                            event.preventDefault();
                            renameRequested.current = false;
                            onStartRename();
                        }
                    }}
                >
                    <DropdownMenuItem onSelect={() => { renameRequested.current = true; }}>Rename</DropdownMenuItem>
                    <DropdownMenuItem onSelect={onEdit}>Edit</DropdownMenuItem>
                    <DropdownMenuItem onSelect={onDelete} className="text-destructive">Delete</DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    </div>;
}
