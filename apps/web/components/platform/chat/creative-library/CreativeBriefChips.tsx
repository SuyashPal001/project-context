import Image from 'next/image';
import { Link2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { FileThumbnail } from '@/components/platform/files/FileThumbnail';
import { creativeSelectionLabel } from './creativeBrief';
import {
    CREATIVE_BRIEF_FIELDS,
    type CreativeBrief,
    type CreativeBriefField,
    type CreativeSelection,
} from './creativeBriefModel';
import { creativeVoiceArtwork } from './creativeVoiceArtwork';

const FIELD_LABELS: Record<CreativeBriefField, string> = {
    template: 'Template',
    avatar: 'Avatar',
    product: 'Product',
    voice: 'Voice',
};

export function CreativeBriefChips({ brief, onEdit, onRemove, readOnly = false }: {
    brief: CreativeBrief;
    onEdit?: (field: CreativeBriefField) => void;
    onRemove?: (field: CreativeBriefField) => void;
    readOnly?: boolean;
}) {
    const selections = CREATIVE_BRIEF_FIELDS.flatMap(field => {
        const selection = brief[field];
        return selection ? [{ field, selection }] : [];
    });
    if (selections.length === 0) return null;

    return <TooltipProvider delayDuration={180}>
        <div aria-label="Selected creative assets" className="flex min-w-0 flex-wrap gap-2">
            {selections.map(({ field, selection }) => {
                const label = `${FIELD_LABELS[field]} ${creativeSelectionLabel(selection)}`;
                if (readOnly) {
                    return <Tooltip key={field}>
                        <TooltipTrigger asChild>
                            <span tabIndex={0} aria-label={label} className="flex h-10 max-w-56 cursor-default items-center gap-2 rounded-full border border-border bg-background/70 p-1 pr-3 text-sm text-foreground shadow-sm outline-none transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring">
                                <SelectionThumbnail selection={selection} />
                                <span className="max-w-36 truncate font-medium">{creativeSelectionLabel(selection)}</span>
                            </span>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" align="start" sideOffset={8} className="w-64 overflow-hidden rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-xl">
                            <SelectionPreview field={field} selection={selection} />
                        </TooltipContent>
                    </Tooltip>;
                }
                return <div key={field} className="flex h-10 max-w-56 items-center rounded-full border border-border bg-background/70 p-1 text-sm text-foreground shadow-sm">
                    <button
                        type="button"
                        aria-label={label}
                        title={`Edit ${FIELD_LABELS[field].toLowerCase()}`}
                        onClick={() => onEdit?.(field)}
                        className="flex h-full min-w-0 items-center gap-2 rounded-l-full pr-1.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <SelectionThumbnail selection={selection} />
                        <span className="max-w-36 truncate font-medium">{creativeSelectionLabel(selection)}</span>
                    </button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${FIELD_LABELS[field].toLowerCase()}`}
                        onClick={() => onRemove?.(field)}
                        className="h-7 w-7 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                    >
                        <X className="h-3.5 w-3.5" />
                    </Button>
                </div>;
            })}
        </div>
    </TooltipProvider>;
}

function SelectionThumbnail({ selection }: { selection: CreativeSelection }) {
    if (selection.kind === 'product-image') {
        return <span className="h-8 w-8 shrink-0 overflow-hidden rounded-full bg-muted"><FileThumbnail fileId={selection.attachment.fileId} alt="" /></span>;
    }
    if (selection.kind === 'product-url') {
        if (selection.imported?.selectedImageId) {
            return <span className="h-8 w-8 shrink-0 overflow-hidden rounded-full bg-muted"><FileThumbnail fileId={selection.imported.selectedImageId} alt="" /></span>;
        }
        return <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><Link2 className="h-4 w-4" /></span>;
    }

    const image = selection.kind === 'voice' ? creativeVoiceArtwork(selection.name) : selection.image;
    if (!image && selection.kind === 'avatar') {
        return <span className="h-8 w-8 shrink-0 overflow-hidden rounded-full bg-muted"><FileThumbnail fileId={selection.attachment.fileId} alt="" /></span>;
    }
    return image
        ? <span className="relative h-8 w-8 shrink-0 overflow-hidden rounded-full bg-muted"><Image src={image} alt="" fill sizes="32px" className="object-cover" /></span>
        : <span className="h-8 w-8 shrink-0 rounded-full bg-muted" aria-hidden />;
}

function SelectionPreview({ field, selection }: { field: CreativeBriefField; selection: CreativeSelection }) {
    const image = selection.kind === 'product-url'
        ? '/creative/products/add-link.jpg'
        : selection.kind === 'voice'
            ? creativeVoiceArtwork(selection.name)
            : selection.kind === 'product-image'
                ? undefined
                : selection.image;
    const subtitle = selection.kind === 'template'
        ? selection.category
        : selection.kind === 'avatar'
            ? `${selection.role} · ${selection.tone}`
            : selection.kind === 'voice'
                ? [selection.tagline, selection.languageLabel].filter(Boolean).join(' · ')
                : selection.kind === 'product-url'
                    ? selection.url
                    : 'Product image';

    return <div>
        <div className="relative aspect-[16/10] w-full overflow-hidden bg-muted">
            {selection.kind === 'product-image' || (selection.kind === 'avatar' && !selection.image)
                ? <FileThumbnail fileId={selection.attachment.fileId} alt={selection.name} />
                : image
                    ? <Image src={image} alt="" fill sizes="256px" className="object-cover" />
                    : <div className="flex h-full items-center justify-center text-muted-foreground"><Link2 className="h-6 w-6" /></div>}
        </div>
        <div className="space-y-0.5 px-3 py-2.5">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{FIELD_LABELS[field]}</p>
            <p className="truncate text-sm font-semibold text-foreground">{creativeSelectionLabel(selection)}</p>
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
    </div>;
}
