'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { importErrorMessage, type BrandRecord } from './brandApi';

export const FILL_FAILED_COPY = "Couldn't read that. Fill it in yourself, or tell Olmo in chat.";

/** The saved source as the user would type it: "fitnearn.com", "@handle". */
function sourceAsTyped(brand: BrandRecord): string {
    if (!brand.sourceValue || brand.sourceType === 'chat') return '';
    return brand.sourceValue.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * The page's one AI action, in the header where Drive has Upload: a button
 * that opens a small card to paste a website or Instagram handle, or hand
 * off to Olmo in chat. The form below stays usable either way.
 */
export function BrandFillButton({ brand, chatHref, onSubmit, busy, failed }: {
    brand: BrandRecord; chatHref: string; onSubmit: (value: string) => Promise<BrandRecord>; busy: boolean; failed: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [value, setValue] = useState(() => sourceAsTyped(brand));
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [edited, setEdited] = useState(false);
    // The card stays open until the read has really started: a typo or an
    // unreadable site is explained right here, not in a toast elsewhere.
    const submit = async () => {
        if (!value.trim() || busy || sending) return;
        setSending(true);
        setError(null);
        try {
            const record = await onSubmit(value.trim());
            if (record.importStatus === 'failed') setError(FILL_FAILED_COPY);
            else setOpen(false);
        } catch (err) {
            setError(importErrorMessage(err, FILL_FAILED_COPY));
        } finally {
            setSending(false);
        }
    };
    const shownError = error ?? (failed && !edited ? FILL_FAILED_COPY : null);

    return (
        <Popover open={open} onOpenChange={(next) => { setOpen(next); setError(null); if (next && !value) setValue(sourceAsTyped(brand)); }}>
            <PopoverTrigger asChild>
                <Button disabled={busy} className="shrink-0 gap-2">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    {busy ? 'Filling in…' : 'Fill in with AI'}
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" collisionPadding={16} className="w-80 space-y-3 rounded-2xl p-4">
                <div>
                    <p className="text-sm font-medium text-foreground">Fill in your brand</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        Paste your website or Instagram. Olmo fills every tab and keeps your edits.
                    </p>
                </div>
                <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                    <Input value={value} onChange={(e) => { setValue(e.target.value); setError(null); setEdited(true); }} placeholder="yourbrand.com or @yourbrand"
                        aria-label="Website or Instagram handle" aria-invalid={Boolean(shownError)} autoFocus />
                    {/* Space kept for the message so the card doesn't jump when one appears. */}
                    <p role="alert" className="min-h-4 text-xs text-destructive">{shownError ?? ''}</p>
                    <Button type="submit" className="w-full" disabled={busy || sending || !value.trim()}>
                        {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Fill in'}
                    </Button>
                </form>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" />
                </div>
                <Link href={chatHref} className="block text-sm font-medium text-foreground hover:text-primary">
                    Tell Olmo in chat →
                </Link>
            </PopoverContent>
        </Popover>
    );
}
