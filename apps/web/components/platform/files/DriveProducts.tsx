"use client";

import { useState } from 'react';
import { ArrowLeft, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FileThumbnail } from './FileThumbnail';
import { AddToChatMenu } from './components/AddToChatMenu';
import { ProductsPanel } from '@/components/platform/chat/creative-library/ProductsPanel';
import type { ProductRecord } from '@/components/platform/chat/creative-library/productsApi';
import type { Attachment } from '@/types/agent-events';
import type { Conversation } from '@/components/platform/chat/types';

/** Drive's Products tab is the product library itself — the same list, cards,
 *  naming, rename and delete as the composer — not a folder of files. */
export function DriveProducts({ conversations, canAddToChat, onAddToChat, onDownload }: {
    conversations: Conversation[];
    canAddToChat: boolean;
    onAddToChat: (attachments: Attachment[], conversationId: string | null) => void;
    onDownload: (fileId: string) => void;
}) {
    const [open, setOpen] = useState<ProductRecord | null>(null);

    if (open) {
        return <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Button variant="ghost" size="sm" onClick={() => setOpen(null)} aria-label="Back to products">
                    <ArrowLeft className="mr-1 h-4 w-4" />Products
                </Button>
                <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-foreground">{open.name}</h2>
                <AddToChatMenu variant="bulk" label="Add photos to chat" conversations={conversations} disabled={!canAddToChat}
                    onPick={conversationId => onAddToChat(open.images, conversationId)} />
                <Button size="sm" variant="outline" onClick={() => open.images.forEach(image => onDownload(image.fileId))}>
                    <Download className="mr-1 h-4 w-4" />Download photos
                </Button>
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {open.images.map(image => <div key={image.fileId} className="min-w-0">
                    <div className="relative aspect-square overflow-hidden rounded-xl border border-border bg-muted">
                        <FileThumbnail fileId={image.fileId} alt="" />
                    </div>
                    <div className="mt-2 flex items-center gap-1">
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={image.name}>{image.name}</span>
                        <AddToChatMenu variant="icon" conversations={conversations} disabled={!canAddToChat}
                            onPick={conversationId => onAddToChat([image], conversationId)} />
                        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Download ${image.name}`} onClick={() => onDownload(image.fileId)}>
                            <Download className="h-4 w-4" />
                        </Button>
                    </div>
                </div>)}
            </div>
        </div>;
    }

    return <ProductsPanel selected={null} onSelect={() => {}} onOpen={setOpen} hideHeading
        emptyHint="Paste a product link or drop photos to add your first product." />;
}
