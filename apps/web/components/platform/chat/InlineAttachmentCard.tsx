'use client';

import { FileVideo, FileAudio, FileImage, FileText, FileSpreadsheet } from 'lucide-react';
import type { MessageAttachment } from './types';
import type { Asset, AssetType } from '@/types/assets';

function classifyMimeType(mimeType: string, filename: string): AssetType {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'text/markdown' || filename.toLowerCase().endsWith('.md')) return 'markdown';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (mimeType === 'text/csv' || filename.toLowerCase().endsWith('.csv')) return 'csv';
  return 'file';
}

const TYPE_ICONS: Record<AssetType, React.ElementType> = {
  video: FileVideo,
  audio: FileAudio,
  image: FileImage,
  markdown: FileText,
  pdf: FileText,
  docx: FileText,
  csv: FileSpreadsheet,
  file: FileText,
  prd: FileText,
  roadmap: FileText,
  tasks: FileText,
};

interface InlineAttachmentCardProps {
  file: MessageAttachment;
  url: string | null;
}

export function InlineAttachmentCard({ file, url }: InlineAttachmentCardProps) {
  const type = classifyMimeType(file.type, file.name);
  const Icon = TYPE_ICONS[type];

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

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-2.5 px-2.5 py-2 bg-muted/40 border border-border/40 rounded-xl text-left hover:bg-muted/70 transition-colors min-w-[160px] max-w-[220px]"
    >
      <div className="h-8 w-8 rounded-lg bg-background border border-border/40 flex items-center justify-center shrink-0 overflow-hidden">
        {(type === 'image') && url ? (
          <img src={url} alt={file.name} className="h-full w-full object-cover" />
        ) : (
          <Icon className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-medium truncate">{file.name}</p>
        <p className="text-[9px] text-muted-foreground uppercase tracking-wide">{type}</p>
      </div>
    </button>
  );
}
