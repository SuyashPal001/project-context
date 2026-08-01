'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { Pack } from './_types';

// The API stores deliveryDate as a full timestamp; <input type="date"> speaks
// YYYY-MM-DD. Convert in both directions rather than storing a date-only string.
function toDateInput(value: string | null): string {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    return parsed.toISOString().slice(0, 10);
}

export function PackDetails({ pack, onSaved }: { pack: Pack; onSaved: () => Promise<void> }) {
    const [title, setTitle] = useState(pack.title ?? '');
    const [scopeSummary, setScopeSummary] = useState(pack.scopeSummary ?? '');
    const [deliveryDate, setDeliveryDate] = useState(toDateInput(pack.deliveryDate));
    const [recipientName, setRecipientName] = useState(pack.recipientName ?? '');
    const [recipientEmail, setRecipientEmail] = useState(pack.recipientEmail ?? '');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function save() {
        if (!title.trim() || saving) return;
        setSaving(true);
        setError(null);
        try {
            await api.patch(`/handover/packs/${pack.id}`, {
                title: title.trim(),
                scopeSummary: scopeSummary.trim() ? scopeSummary.trim() : null,
                // The Zod schema is .datetime(); a bare YYYY-MM-DD is rejected.
                deliveryDate: deliveryDate ? new Date(`${deliveryDate}T00:00:00Z`).toISOString() : null,
                recipientName: recipientName.trim() ? recipientName.trim() : null,
                // recipientEmail is validated as an email — an empty string 400s.
                recipientEmail: recipientEmail.trim() ? recipientEmail.trim() : null,
            });
            await onSaved();
        } catch (err: any) {
            setError(err?.data?.error ?? 'Could not save the pack details');
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="rounded-xl border border-border bg-card p-5">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Pack details</p>
            <div className="mt-4 space-y-2">
                <Input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
                <Textarea
                    placeholder="Scope summary — what this project delivered"
                    value={scopeSummary}
                    onChange={(e) => setScopeSummary(e.target.value)}
                />
                <div className="flex gap-2">
                    <Input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
                    <Input placeholder="Client contact name" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} />
                    <Input
                        type="email"
                        placeholder="Client email"
                        value={recipientEmail}
                        onChange={(e) => setRecipientEmail(e.target.value)}
                    />
                </div>
                {error ? <p className="text-sm text-destructive">{error}</p> : null}
                <Button onClick={save} disabled={!title.trim() || saving}>
                    {saving ? 'Saving…' : 'Save details'}
                </Button>
            </div>
        </div>
    );
}
