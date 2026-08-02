'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { Item, Section } from './_types';

export function ItemEditor({
    section,
    items,
    readOnly,
    onCreate,
    onDelete,
}: {
    section: Section;
    items: Item[];
    readOnly: boolean;
    onCreate: (input: { title: string; description: string; statusLabel: string; categoryLabel: string }) => Promise<void>;
    onDelete: (itemId: string) => Promise<void>;
}) {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [statusLabel, setStatusLabel] = useState('');
    const [categoryLabel, setCategoryLabel] = useState('');
    const [saving, setSaving] = useState(false);

    async function submit() {
        if (!title.trim() || saving) return;
        setSaving(true);
        try {
            await onCreate({ title: title.trim(), description: description.trim(), statusLabel: statusLabel.trim(), categoryLabel: categoryLabel.trim() });
            setTitle('');
            setDescription('');
            setStatusLabel('');
            setCategoryLabel('');
        } finally {
            setSaving(false);
        }
    }

    return (
        <div>
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{section.eyebrow}</p>
            <h2 className="mt-2 text-2xl font-bold">{section.subtitle}</h2>

            {section.kind === 'credentials' ? (
                <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-500/90">
                    Record <strong className="font-semibold">who owns each account</strong> and how access was
                    transferred — not passwords. Anyone with the pack link can read this section, so share
                    credentials themselves through your password manager.
                </p>
            ) : null}

            <div className="mt-6 space-y-3">
                {items.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                        No records yet.
                    </p>
                ) : (
                    items.map((item) => (
                        <div key={item.id} className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3">
                            <div className="flex-1">
                                <div className="flex items-center gap-2">
                                    <span className="font-medium">{item.title}</span>
                                    {item.statusLabel ? (
                                        <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-500">{item.statusLabel}</span>
                                    ) : null}
                                    {item.categoryLabel ? (
                                        <span className="ml-auto rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">{item.categoryLabel}</span>
                                    ) : null}
                                </div>
                                {item.description ? (
                                    <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
                                ) : null}
                            </div>
                            {readOnly ? null : (
                                <button type="button" onClick={() => onDelete(item.id)} aria-label={`Delete ${item.title}`}>
                                    <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                                </button>
                            )}
                        </div>
                    ))
                )}
            </div>

            {readOnly ? null : (
                <div className="mt-6 space-y-2 rounded-xl border border-border p-4">
                    <Input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
                    <Textarea placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
                    <div className="flex gap-2">
                        <Input placeholder="Status label (e.g. Complete)" value={statusLabel} onChange={(e) => setStatusLabel(e.target.value)} />
                        <Input placeholder="Category label (e.g. Delivered)" value={categoryLabel} onChange={(e) => setCategoryLabel(e.target.value)} />
                    </div>
                    <Button onClick={submit} disabled={!title.trim() || saving}>
                        {saving ? 'Adding…' : 'Add record'}
                    </Button>
                </div>
            )}
        </div>
    );
}
