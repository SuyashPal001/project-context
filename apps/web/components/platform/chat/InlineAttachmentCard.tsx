'use client';

import type { MessageAttachment } from './types';
import type { Asset } from '@/types/assets';
import { assetTypeForFile } from '@/lib/assetType';
import { TYPE_ICONS, TYPE_STYLES, TYPE_BADGES } from '@/components/platform/canvas/assetTypeStyles';
import { formatFileSize } from '@/components/platform/files/lib/fileIcons';

interface InlineAttachmentCardProps {
  file: MessageAttachment;
  url: string | null;
}

export function InlineAttachmentCard({ file, url }: InlineAttachmentCardProps) {
  // Shared with the composer tray, the canvas gallery and the Drive grid. The
  // local copy this replaced had no extension fallback, so an mp3 uploaded as
  // application/octet-stream classified as a generic file.
  const type = assetTypeForFile(file.type, file.name);
  const Icon = TYPE_ICONS[type];
  const typeStyle = TYPE_STYLES[type];

  const handleClick = () => {
    if (!file.fileId) return; // nothing to open in the right pane without a persisted reference
    const asset: Asset = {
      id: file.fileId,
      type,
      filename: file.name,
      mimeType: file.type,
      thumbnailUrl: url ?? file.previewUrl,
      size: file.size,
      createdAt: new Date().toISOString(),
      sourceMessageId: '',
      fileId: file.fileId,
    };
    (window as any).__openCanvas?.();
    (window as any).__canvasUpdate?.('asset_open', { asset });
  };

  const isMedia = type === 'image' || type === 'video';

  // Media (image/video) gets the big aspect-video card — same shape as
  // ToolCallCard's loading skeleton so the result swaps in without resizing.
  // Everything else (docx/pdf/csv/...) gets the same 80x80 tile the composer
  // tray uses (AttachmentStrip's AttachmentTile) — a preview doesn't make
  // sense for those, so match what the user already sees on the way in.
  if (isMedia) {
    return (
      <button
        onClick={handleClick}
        // A definite width, not w-full: every child here is absolutely
        // positioned (badge/img/caption), so the button has zero in-flow
        // content. Its ancestor column is align-items:flex-start/flex-end
        // (shrink-to-fit) with no width class of its own, so a percentage
        // width resolved against that indefinite box collapsed to 0 — and
        // aspect-video turned 0 width into 0 height, making the whole card
        // occupy zero pixels. Generated images rendered nothing; the fixed
        // h-20 w-20 non-media tile below was unaffected.
        className={`relative block w-[240px] max-w-full aspect-video rounded-xl border border-border/60 overflow-hidden text-left hover:border-border transition-colors ${typeStyle.bg}`}
      >
        <span className="absolute top-1.5 left-1.5 z-10 text-[9px] font-bold px-1.5 py-0.5 rounded bg-background/90 border border-border/60">
          {TYPE_BADGES[type]}
        </span>

        {url ? (
          type === 'image' ? (
            <img src={url} alt={file.name} className="absolute inset-0 h-full w-full object-cover" />
          ) : (
            <video src={url} className="absolute inset-0 h-full w-full object-cover" muted />
          )
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <Icon className={`h-6 w-6 ${typeStyle.icon}`} />
          </div>
        )}

        <div className="absolute inset-x-0 bottom-0 px-2 py-1.5 bg-gradient-to-t from-black/80 to-transparent">
          <p className="text-[11px] font-medium text-white truncate">{file.name}</p>
          <p className="text-[9px] text-white/70 uppercase tracking-wide">
            {type}{typeof file.size === 'number' ? ` · ${formatFileSize(file.size)}` : ''}
          </p>
        </div>
      </button>
    );
  }

  return (
    <button
      onClick={handleClick}
      className={`relative h-20 w-20 rounded-xl overflow-hidden border border-border/40 shadow-sm text-left hover:border-border transition-colors ${typeStyle.bg}`}
    >
      <div className="h-full w-full flex flex-col items-center justify-center gap-1 p-2">
        <Icon className={`h-7 w-7 ${typeStyle.icon}`} />
        <span className="text-[9px] font-medium line-clamp-2 text-center break-all leading-tight">{file.name}</span>
      </div>
      <span className="absolute top-1 left-1 text-[8px] font-bold px-1 py-0.5 rounded bg-background/90 border border-border/60">
        {TYPE_BADGES[type]}
      </span>
    </button>
  );
}
