'use client';

import { useRef, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FileThumbnail } from '@/components/platform/files/FileThumbnail';
import type { Attachment } from '@/types/agent-events';
import { PRODUCT_CATEGORIES } from './productCategories';
import { storeCreativeImage } from './storeCreativeImage';
import type { ProductRecord } from './productsApi';

const MAX_USPS = 3;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 5000;
const MAX_USP_LENGTH = 200;
// Same caps ProductsPanel's own photo-drop path enforces.
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 35 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PRODUCT_PREFIX = 'creative-products/';

/** The form always supplies a trimmed name in both create and edit mode — the
 *  "Create product" button stays disabled until create mode has one. Kept
 *  narrower than productsApi's ProductSetupFields (whose name is optional,
 *  a general partial-update shape) so callers never need to assert it. */
export interface ProductSetupSubmission {
    name: string;
    category: string | null;
    description: string | null;
    usps: string[];
    /** Ordered; the first id is the cover image. */
    imageFileIds: string[];
}

export function ProductSetupModal({ open, onOpenChange, product, onSave }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** null = create mode, blank form. A record = edit mode, prefilled. */
    product: ProductRecord | null;
    onSave: (fields: ProductSetupSubmission) => void | Promise<void>;
}) {
    const [saving, setSaving] = useState(false);
    // Lazy initializers seed the first mount correctly whether it starts open
    // or closed; the render-time check below re-seeds a later open of the
    // same mounted instance (this component stays mounted across
    // close/reopen — it only ever renders null while closed).
    const [name, setName] = useState(() => product?.name ?? '');
    const [category, setCategory] = useState<string | null>(() => product?.category ?? null);
    const [description, setDescription] = useState(() => product?.description ?? '');
    const [usps, setUsps] = useState<string[]>(() => product && product.usps.length > 0 ? product.usps : ['']);
    const [images, setImages] = useState<Attachment[]>(() => product?.images ?? []);
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // React's documented pattern for resetting state on a prop change (done
    // synchronously during render, not inside an effect — an effect here
    // would set state on the render right after the one that opened the
    // dialog, an extra visible flash of stale fields before the reset).
    const [wasOpen, setWasOpen] = useState(open);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (open) {
            setName(product?.name ?? '');
            setCategory(product?.category ?? null);
            setDescription(product?.description ?? '');
            setUsps(product && product.usps.length > 0 ? product.usps : ['']);
            setImages(product?.images ?? []);
            setSaving(false);
            setUploading(false);
        }
    }

    if (!open) return null;

    const trimmedName = name.trim();
    const canSubmit = trimmedName.length > 0 && !saving && !uploading;

    async function addPhotos(fileList: FileList | null) {
        const files = Array.from(fileList ?? []);
        if (files.length === 0) return;
        const room = MAX_PHOTOS - images.length;
        if (files.length > room) { toast.error(`Add up to ${MAX_PHOTOS} photos total.`); return; }
        if (files.some(file => !IMAGE_TYPES.has(file.type))) { toast.error('Choose JPG, PNG, or WebP images.'); return; }
        if (files.some(file => file.size > MAX_PHOTO_BYTES)) { toast.error('Product images must be under 35 MB.'); return; }
        setUploading(true);
        try {
            // allSettled, not all: one failed upload must not discard the others
            // that already succeeded — those bytes are already written to S3, so
            // dropping them from `images` would both lose real work and leave an
            // orphaned file (only referenced product images are ever cleaned up).
            const results = await Promise.allSettled(files.map(file => storeCreativeImage(file, PRODUCT_PREFIX)));
            const uploaded = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
            if (uploaded.length > 0) setImages(prev => [...prev, ...uploaded]);
            const failedCount = results.length - uploaded.length;
            if (failedCount > 0) toast.error(`${failedCount} of ${results.length} photos could not be added. Please try again.`);
        } finally {
            setUploading(false);
        }
    }

    async function submit() {
        setSaving(true);
        try {
            await onSave({
                name: trimmedName,
                category,
                description: description.trim() || null,
                usps: usps.map(u => u.trim()).filter(Boolean),
                imageFileIds: images.map(image => image.fileId),
            });
        } finally {
            // Harmless if onSave already closed the dialog (onOpenChange(false)):
            // this component stays mounted and just renders null next render.
            setSaving(false);
        }
    }

    return <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
            <DialogHeader>
                <DialogTitle>Setup your product</DialogTitle>
                <DialogDescription>Add your product details and visuals so you can mention it in chat.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                        <Label htmlFor="product-setup-name">Product name *</Label>
                        <Input id="product-setup-name" aria-label="Product name" value={name} maxLength={MAX_NAME}
                            onChange={event => setName(event.target.value)} placeholder="e.g. Men's Quarter-Zip Hoodie" />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="product-setup-category">Category</Label>
                        <Select value={category ?? '__none'} onValueChange={value => setCategory(value === '__none' ? null : value)}>
                            <SelectTrigger id="product-setup-category" aria-label="Category">
                                <SelectValue placeholder="Select a product category…" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__none">No category</SelectItem>
                                {PRODUCT_CATEGORIES.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor="product-setup-description">Product description</Label>
                    <Textarea id="product-setup-description" aria-label="Product description" value={description} maxLength={MAX_DESCRIPTION}
                        onChange={event => setDescription(event.target.value)} placeholder="e.g. Street-ready hoodie made from soft cotton blend." rows={3} />
                </div>
                <div className="space-y-2">
                    <Label>Selling points (USPs)</Label>
                    {usps.map((value, index) => <div key={index} className="flex items-center gap-2">
                        <Input aria-label={`Selling point ${index + 1}`} value={value} maxLength={MAX_USP_LENGTH} placeholder="e.g. Soft cotton blend, Sporty street style"
                            onChange={event => setUsps(prev => prev.map((u, i) => i === index ? event.target.value : u))} />
                        {usps.length > 1 && <Button type="button" variant="outline" size="icon" aria-label="Remove selling point"
                            onClick={() => setUsps(prev => prev.filter((_, i) => i !== index))}>
                            <X className="h-4 w-4" />
                        </Button>}
                    </div>)}
                    {usps.length < MAX_USPS && <Button type="button" variant="outline" size="sm" aria-label="Add selling point"
                        onClick={() => setUsps(prev => [...prev, ''])}>
                        <Plus className="mr-1 h-4 w-4" />Add one more
                    </Button>}
                </div>
                <div className="space-y-2">
                    <Label>Media</Label>
                    <p className="text-xs text-muted-foreground">The first photo is the cover.</p>
                    <div className="flex flex-wrap gap-2">
                        {images.map((image, index) => <div key={image.fileId} className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
                            <FileThumbnail fileId={image.fileId} alt={image.name} />
                            <button type="button" aria-label={`Remove ${image.name}`}
                                className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-background/90 text-foreground"
                                onClick={() => setImages(prev => prev.filter((_, i) => i !== index))}>
                                <X className="h-3 w-3" />
                            </button>
                        </div>)}
                        {images.length < MAX_PHOTOS && <>
                            <button type="button" disabled={uploading}
                                onClick={() => fileInputRef.current?.click()}
                                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground hover:border-foreground/50 disabled:pointer-events-none disabled:opacity-50">
                                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-5 w-5" />}
                            </button>
                            <input ref={fileInputRef} type="file" multiple accept="image/jpeg,image/png,image/webp" className="hidden"
                                aria-label="Add product photos" onChange={event => { void addPhotos(event.target.files); event.target.value = ''; }} />
                        </>}
                    </div>
                </div>
            </div>
            <DialogFooter>
                <Button variant="ghost" onClick={() => onOpenChange(false)}>Discard</Button>
                <Button onClick={() => void submit()} disabled={!canSubmit}>{product ? 'Save changes' : 'Create product'}</Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>;
}
