'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ReadinessChecklist } from './ReadinessChecklist';
import { SectionRail } from './SectionRail';
import { ItemEditor } from './ItemEditor';
import type { Item, Pack, Readiness, Section } from './_types';

export default function HandoverBuilderPage() {
    const { planId } = useParams<{ planId: string }>();

    const [pack, setPack] = useState<Pack | null>(null);
    const [sections, setSections] = useState<Section[]>([]);
    const [items, setItems] = useState<Item[]>([]);
    const [readiness, setReadiness] = useState<Readiness | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [sentUrl, setSentUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const loadPack = useCallback(async (packId: string) => {
        const detail = await api.get<{ data: { pack: Pack; sections: Section[]; items: Item[] } }>(`/handover/packs/${packId}`);
        setPack(detail.data.pack);
        setSections(detail.data.sections);
        setItems(detail.data.items);
        setSelectedId((current) => current ?? detail.data.sections[0]?.id ?? null);
        const r = await api.get<{ data: Readiness }>(`/handover/packs/${packId}/readiness`);
        setReadiness(r.data);
    }, []);

    // Load the existing pack, if there is one. Visiting a page must never
    // create data — the agency creates the pack explicitly.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const existing = await api.get<{ data: Pack | null }>(`/handover/packs?planId=${planId}`);
                if (cancelled) return;
                if (existing.data) await loadPack(existing.data.id);
            } catch (err: any) {
                if (!cancelled) setError(err?.data?.error ?? 'Could not load the handover pack');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [planId, loadPack]);

    async function createPack() {
        setError(null);
        try {
            const created = await api.post<{ data: Pack }>('/handover/packs', {
                planId,
                title: 'Project handover',
            });
            await loadPack(created.data.id);
        } catch (err: any) {
            setError(err?.data?.error ?? 'Could not create the handover pack');
        }
    }

    const selected = sections.find((s) => s.id === selectedId) ?? null;
    const readOnly = pack?.status === 'signed' || pack?.status === 'revoked';

    async function createItem(input: { title: string; description: string; statusLabel: string; categoryLabel: string }) {
        if (!pack || !selected) return;
        await api.post(`/handover/packs/${pack.id}/items`, { sectionId: selected.id, ...input });
        await loadPack(pack.id);
    }

    async function deleteItem(itemId: string) {
        if (!pack) return;
        // The client exposes DELETE as `del`, not `delete` — see apps/web/lib/api.ts.
        await api.del(`/handover/packs/${pack.id}/items/${itemId}`);
        await loadPack(pack.id);
    }

    async function send() {
        if (!pack) return;
        try {
            const res = await api.post<{ data: { url: string } }>(`/handover/packs/${pack.id}/send`, {});
            setSentUrl(res.data.url);
            await loadPack(pack.id);
        } catch (err: any) {
            setError(err?.data?.error ?? 'Could not send the pack');
        }
    }

    if (loading) return <div className="p-8 text-sm text-muted-foreground">Loading handover pack…</div>;
    if (error) return <div className="p-8 text-sm text-destructive">{error}</div>;

    if (!pack) {
        return (
            <div className="p-8">
                <h1 className="text-2xl font-bold">Handover pack</h1>
                <p className="mt-2 max-w-md text-sm text-muted-foreground">
                    This project does not have a handover pack yet. Creating one seeds the five
                    closeout sections, which you can then fill in and send to the client.
                </p>
                <Button className="mt-6" onClick={createPack}>Create handover pack</Button>
            </div>
        );
    }

    return (
        <div className="p-8">
            <div className="mb-6 flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold">{pack.title}</h1>
                    <p className="text-sm text-muted-foreground">Status: {pack.status}</p>
                </div>
                <Button onClick={send} disabled={readOnly || !readiness || readiness.complete < readiness.total}>
                    Send to client
                </Button>
            </div>

            {sentUrl ? (
                <div className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
                    <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Client portal</p>
                    <p className="mt-1 break-all font-mono text-sm">{sentUrl}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                        Copy this now — it is shown once and cannot be retrieved later.
                    </p>
                </div>
            ) : null}

            {readiness ? <div className="mb-6"><ReadinessChecklist readiness={readiness} /></div> : null}

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
                <SectionRail sections={sections} items={items} selectedId={selectedId} onSelect={setSelectedId} />
                <div className="rounded-xl border border-border bg-card p-6">
                    {selected ? (
                        <ItemEditor
                            section={selected}
                            items={items.filter((item) => item.sectionId === selected.id)}
                            readOnly={readOnly}
                            onCreate={createItem}
                            onDelete={deleteItem}
                        />
                    ) : null}
                </div>
            </div>
        </div>
    );
}
