'use client';

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PRODUCT_CATEGORIES } from './productCategories';
import type { ProductRecord } from './productsApi';

const MAX_USPS = 3;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 5000;
const MAX_USP_LENGTH = 200;

/** The form always supplies a trimmed name in both create and edit mode — the
 *  "Create product" button stays disabled until create mode has one. Kept
 *  narrower than productsApi's ProductSetupFields (whose name is optional,
 *  a general partial-update shape) so callers never need to assert it. */
export interface ProductSetupSubmission {
    name: string;
    category: string | null;
    description: string | null;
    usps: string[];
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
            setSaving(false);
        }
    }

    if (!open) return null;

    const trimmedName = name.trim();
    const canSubmit = trimmedName.length > 0 && !saving;

    async function submit() {
        setSaving(true);
        try {
            await onSave({
                name: trimmedName,
                category,
                description: description.trim() || null,
                usps: usps.map(u => u.trim()).filter(Boolean),
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
            </div>
            <DialogFooter>
                <Button variant="ghost" onClick={() => onOpenChange(false)}>Discard</Button>
                <Button onClick={() => void submit()} disabled={!canSubmit}>{product ? 'Save changes' : 'Create product'}</Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>;
}
