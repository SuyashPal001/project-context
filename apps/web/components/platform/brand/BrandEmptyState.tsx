'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export const FAILED_COPY = "Couldn't read that. Tell Olmo about your brand instead.";

export function BrandEmptyState({ chatHref, onSubmit, busy, failed }: {
    chatHref: string; onSubmit: (value: string) => void; busy: boolean; failed: boolean;
}) {
    const [value, setValue] = useState('');
    const submit = () => { if (value.trim() && !busy) onSubmit(value.trim()); };
    return (
        <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-16 text-center">
            <p className="text-base font-medium text-foreground">Paste your website or Instagram handle</p>
            <form className="flex w-full gap-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
                <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="yourbrand.com  or  @yourbrand" aria-label="Website or Instagram handle" />
                <Button type="submit" disabled={busy || !value.trim()}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Fill in'}
                </Button>
            </form>
            {failed && <p className="text-sm text-destructive">{FAILED_COPY}</p>}
            <Link href={chatHref} className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                No website? Tell Olmo about your brand →
            </Link>
        </div>
    );
}
