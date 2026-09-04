'use client';

import { InlineAttachmentCard } from './InlineAttachmentCard';
import type { MessageAttachment } from './types';
import { microToCredits } from '@/lib/hooks/useCredits';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface GeneratedAssetCardProps {
  file: MessageAttachment;
  url: string | null;
  createdAt: string;
}

// Wraps InlineAttachmentCard (unmodified — same click-to-open-on-canvas
// behavior) with a credit-cost pill overlay, shown only when the file
// carries generation metadata (i.e. it came from generate_image/generate_video,
// not a user upload). The pill's own click is stopped from bubbling so it
// doesn't also trigger the card's open-on-canvas handler underneath it.
export function GeneratedAssetCard({ file, url, createdAt }: GeneratedAssetCardProps) {
  if (!file.generation) {
    return <InlineAttachmentCard file={file} url={url} />;
  }

  const { creditsUsedMicro, model } = file.generation;
  const credits = microToCredits(creditsUsedMicro);

  return (
    <div className="relative inline-block">
      <InlineAttachmentCard file={file} url={url} />
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="generation-credit-pill"
            onClick={(e) => e.stopPropagation()}
            className="absolute top-1.5 right-1.5 z-10 text-[9px] font-bold px-1.5 py-0.5 rounded bg-background/90 border border-border/60 hover:bg-background transition-colors"
          >
            {credits.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          className="w-56 p-3 text-xs space-y-1.5"
          data-testid="generation-details"
        >
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Model</span>
            <span className="font-mono">{model}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Created</span>
            <span>{new Date(createdAt).toLocaleString()}</span>
          </div>
          <div className="flex items-center justify-between pt-1.5 border-t border-border/60 font-medium">
            <span>Credits used</span>
            <span className="font-mono">{credits.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
