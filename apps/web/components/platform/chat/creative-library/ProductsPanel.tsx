"use client";

import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ImagePlus, Loader2, MoreHorizontal, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { FileThumbnail } from '@/components/platform/files/FileThumbnail';
import { cn } from '@/lib/utils';
import type { ProductSelection } from './creativeBriefModel';
import { storeCreativeImage } from './storeCreativeImage';
import {
    PRODUCTS_PAGE_SIZE, createProductFromFiles, deleteProduct, describeProduct, importProductFromUrl,
    listProducts, productSelection, renameProduct, type ProductRecord,
} from './productsApi';

const PRODUCT_PREFIX = 'creative-products/';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 35 * 1024 * 1024;
const DELETE_UNDO_MS = 5000;
const LINK_FAILED = "Couldn't read this page. Drop a product photo instead.";

export function ProductsPanel({ selected, onSelect }: { selected: ProductSelection | null; onSelect: (selection: ProductSelection) => void }) {
    const queryClient = useQueryClient();
    const inputRef = useRef<HTMLInputElement>(null);
    const mountedRef = useRef(true);
    const selectedIdRef = useRef<string | null>(null);
    const pendingDeletes = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const [search, setSearch] = useState('');
    const [link, setLink] = useState('');
    const [busy, setBusy] = useState<'link' | 'photos' | null>(null);
    const [linkError, setLinkError] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);
    const [hidden, setHidden] = useState<Set<string>>(() => new Set());
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    selectedIdRef.current = selected?.kind === 'product' ? selected.id : null;

    const { data, isPending, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
        queryKey: ['creative-products', search.trim()],
        initialPageParam: 0,
        queryFn: ({ pageParam }) => listProducts(search, pageParam),
        getNextPageParam: (last, pages) => last.data.length === PRODUCTS_PAGE_SIZE ? pages.length * PRODUCTS_PAGE_SIZE : undefined,
    });
    const products = (data?.pages.flatMap(page => page.data) ?? []).filter(product => !hidden.has(product.id));
    // Deliberately not gated on `isPending`: a brand-new tenant's very first load is the
    // common case this line exists for, and it should read immediately rather than flash
    // in only once the (usually empty) initial fetch resolves.
    const isEmpty = !isError && products.length === 0 && !search.trim();

    useEffect(() => {
        mountedRef.current = true;
        const deletes = pendingDeletes.current;
        return () => {
            mountedRef.current = false;
            // Leaving the panel commits any delete still inside its undo window.
            for (const [id, timer] of deletes) { clearTimeout(timer); void deleteProduct(id).catch(() => {}); }
            deletes.clear();
        };
    }, []);

    const refresh = () => queryClient.invalidateQueries({ queryKey: ['creative-products'] });
    const unhide = (id: string) => setHidden(prev => { const next = new Set(prev); next.delete(id); return next; });

    async function nameIfPending(product: ProductRecord) {
        if (product.namingStatus !== 'pending') return;
        try {
            const named = await describeProduct(product.id);
            // Only update the brief if the user still has this product picked.
            if (mountedRef.current && selectedIdRef.current === named.id) onSelect(productSelection(named));
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

    function removeProduct(product: ProductRecord) {
        setHidden(prev => new Set(prev).add(product.id));
        const timer = setTimeout(() => {
            pendingDeletes.current.delete(product.id);
            deleteProduct(product.id).then(refresh).catch(() => {
                if (!mountedRef.current) return;
                unhide(product.id);
                toast.error('Could not delete the product.');
            });
        }, DELETE_UNDO_MS);
        pendingDeletes.current.set(product.id, timer);
        toast.success('Product deleted', {
            action: { label: 'Undo', onClick: () => { clearTimeout(timer); pendingDeletes.current.delete(product.id); unhide(product.id); } },
        });
    }

    return <div className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">Products</h2>
            {!isEmpty && <div className="relative w-full sm:w-64">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search products" aria-label="Search products" className="h-9 pl-9" />
            </div>}
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
            {isEmpty && <p className="text-xs text-muted-foreground">You can skip this. Olmo will ask about your product in chat.</p>}
            <input ref={inputRef} type="file" multiple accept="image/jpeg,image/png,image/webp" className="hidden" aria-label="Upload product photos"
                onChange={event => { const files = event.target.files; if (files?.length) void addPhotos(files); event.target.value = ''; }} />
        </div>
        {isPending ? <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div> :
            isError ? <div className="py-10 text-center text-sm text-muted-foreground">Could not load products. <Button variant="link" onClick={() => void refetch()}>Retry</Button></div> :
                products.length === 0 && !busy ? (search.trim() ? <p className="py-10 text-center text-sm text-muted-foreground">No products match your search.</p> : null) :
                    <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3">
                        {busy && <div className="min-w-0" aria-live="polite">
                            <div className="flex aspect-square items-center justify-center rounded-xl border border-border bg-muted"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                            <span className="mt-2 block text-sm text-muted-foreground">Adding…</span>
                        </div>}
                        {products.map(product => <ProductCard
                            key={product.id}
                            product={product}
                            selected={selected?.kind === 'product' && selected.id === product.id}
                            renaming={renamingId === product.id}
                            renameValue={renameValue}
                            onRenameChange={setRenameValue}
                            onRenameCommit={() => void commitRename(product)}
                            onRenameCancel={() => { setRenameValue(product.name); setRenamingId(null); }}
                            onStartRename={() => { setRenameValue(product.name); setRenamingId(product.id); }}
                            onDelete={() => removeProduct(product)}
                            onUse={() => { selectedIdRef.current = product.id; onSelect(productSelection(product)); }}
                        />)}
                    </div>}
        {hasNextPage && <div className="flex justify-center"><Button variant="outline" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>{isFetchingNextPage ? 'Loading…' : 'Load more products'}</Button></div>}
    </div>;
}

function ProductCard({ product, selected, renaming, renameValue, onRenameChange, onRenameCommit, onRenameCancel, onStartRename, onDelete, onUse }: {
    product: ProductRecord; selected: boolean; renaming: boolean; renameValue: string;
    onRenameChange: (value: string) => void; onRenameCommit: () => void; onRenameCancel: () => void;
    onStartRename: () => void; onDelete: () => void; onUse: () => void;
}) {
    const main = product.images[0];
    const pending = product.namingStatus === 'pending';
    const label = pending ? 'Naming…' : product.name;
    return <div className="group min-w-0">
        <button type="button" aria-pressed={selected} aria-label={`Use ${product.name}`} onClick={onUse}
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
                <DropdownMenuContent align="end">
                    {/* Radix restores focus to the trigger asynchronously (a rAF-timed step) as the
                        menu closes. Mounting the autoFocus rename input synchronously inside onSelect
                        (or even on the next tick via setTimeout 0) races that restore: it steals focus
                        back from the input and fires our onBlur-commit before the user typed anything.
                        A short delay — longer than Radix's own restore step — lets that settle first,
                        the pattern Radix's own docs use for opening a dialog from a menu item. */}
                    <DropdownMenuItem onSelect={() => { setTimeout(onStartRename, 50); }}>Rename</DropdownMenuItem>
                    <DropdownMenuItem onSelect={onDelete} className="text-destructive">Delete</DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    </div>;
}
