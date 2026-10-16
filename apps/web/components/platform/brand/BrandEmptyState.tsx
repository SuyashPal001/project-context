'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export const FAILED_COPY = "Couldn't read that. Tell Olmo about your brand instead.";

/** Three first-run choices, stacked and left-aligned — no boxed cards, just
 * rows/buttons under the page heading. */
export function BrandEmptyState({ chatHref, onSubmit, busy, failed, onStartManual }: {
    chatHref: string; onSubmit: (value: string) => void; busy: boolean; failed: boolean; onStartManual: () => void;
}) {
    const [showImport, setShowImport] = useState(false);
    const [value, setValue] = useState('');
    const submit = () => { if (value.trim() && !busy) onSubmit(value.trim()); };

    return (
        <div className="flex flex-col items-start gap-4 pt-8">
            <div className="flex flex-col items-start gap-2">
                <button type="button" onClick={() => setShowImport((s) => !s)}
                    className="text-base font-medium text-foreground hover:text-primary">
                    Fill from my website or Instagram
                </button>
                {showImport && (
                    <form className="flex w-full max-w-md gap-2 pt-1" onSubmit={(e) => { e.preventDefault(); submit(); }}>
                        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="yourbrand.com  or  @yourbrand" aria-label="Website or Instagram handle" autoFocus />
                        <Button type="submit" disabled={busy || !value.trim()}>
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Fill in'}
                        </Button>
                    </form>
                )}
                {failed && <p className="text-sm text-destructive">{FAILED_COPY}</p>}
            </div>

            <Link href={chatHref} className="text-base font-medium text-foreground hover:text-primary">
                Set it up with Olmo in chat
            </Link>

            <button type="button" onClick={onStartManual} className="text-base font-medium text-foreground hover:text-primary">
                Fill it in myself
            </button>
        </div>
    );
}
