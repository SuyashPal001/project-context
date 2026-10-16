'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { BrandRecord } from './brandApi';

export const FILL_ROW_FAILED_COPY = "Couldn't read that — fill it in below, or ask Olmo.";

/**
 * Always-on shortcut above the form: paste a site/handle and import fills
 * the fields below, or hand off to Olmo in chat. Once the brand has a real
 * import source (website/instagram), this row steps aside — the bottom
 * "Filled from … · Refresh" line in LookSection covers re-import from then
 * on. No box: one line, left-aligned, wraps cleanly at phone width.
 */
export function BrandFillRow({ brand, chatHref, onSubmit, busy, failed }: {
    brand: BrandRecord; chatHref: string; onSubmit: (value: string) => void; busy: boolean; failed: boolean;
}) {
    const [value, setValue] = useState('');
    if (brand.sourceType && brand.sourceType !== 'chat') return null;

    const submit = () => { if (value.trim() && !busy) onSubmit(value.trim()); };

    return (
        <div className="flex flex-col gap-2 pb-6">
            <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
                <span className="text-sm font-medium text-foreground">Fill it in for me</span>
                <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="yourbrand.com or @yourbrand"
                    aria-label="Website or Instagram handle" className="min-w-0 basis-full sm:basis-auto sm:w-56" />
                <Button type="submit" size="sm" disabled={busy || !value.trim()}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Fill in'}
                </Button>
                <span className="text-sm text-muted-foreground">or</span>
                <Link href={chatHref} className="text-sm font-medium text-foreground hover:text-primary">
                    Ask Olmo →
                </Link>
            </form>
            {failed && <p className="text-sm text-destructive">{FILL_ROW_FAILED_COPY}</p>}
        </div>
    );
}
