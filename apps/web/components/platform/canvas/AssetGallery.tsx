'use client';

import { FileVideo, FileAudio, FileImage, FileText, File as FileIcon } from 'lucide-react';
import { useConversationAssets } from '@/hooks/useConversationAssets';
import type { Asset, AssetType } from '@/types/assets';

interface AssetGalleryProps {
  conversationId: string;
  filterAssetId?: string;
  onCardClick: (asset: Asset, allAssets: Asset[]) => void;
}

const TYPE_ICONS: Record<AssetType, React.ElementType> = {
  video: FileVideo,
  audio: FileAudio,
  image: FileImage,
  markdown: FileText,
  file: FileIcon,
  prd: FileText,
  roadmap: FileText,
  tasks: FileText,
};

const TYPE_BADGES: Record<AssetType, string> = {
  video: 'MP4',
  audio: 'MP3',
  image: 'IMG',
  markdown: 'MD',
  file: 'FILE',
  prd: 'PRD',
  roadmap: 'ROADMAP',
  tasks: 'TASKS',
};

function AssetCard({ asset, onClick }: { asset: Asset; onClick: () => void }) {
  const Icon = TYPE_ICONS[asset.type];
  return (
    <div className="group relative flex flex-col rounded-xl border border-border/60 bg-muted/20 overflow-hidden">
      <button onClick={onClick} className="text-left hover:border-primary/40 transition-colors">
        <div className="relative aspect-video bg-muted flex items-center justify-center">
          {asset.thumbnailUrl ? (
            <img src={asset.thumbnailUrl} alt={asset.filename} className="w-full h-full object-cover" />
          ) : (
            <Icon className="h-8 w-8 text-muted-foreground/60" />
          )}
          <span className="absolute top-1.5 left-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-background/90 border border-border/60">
            {TYPE_BADGES[asset.type]}
          </span>
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors">
            <button
              onClick={(e) => {
                e.stopPropagation();
                (window as any).__addComposeAttachment?.(asset);
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity px-3 py-1.5 rounded-full bg-background text-foreground text-xs font-medium shadow-sm hover:bg-muted"
            >
              + Add to task
            </button>
          </div>
        </div>
        <div className="px-2.5 py-2">
          <p className="text-xs font-medium truncate">{asset.filename}</p>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{asset.type}</p>
        </div>
      </button>
    </div>
  );
}

export function AssetGallery({ conversationId, filterAssetId, onCardClick }: AssetGalleryProps) {
  const { assets, isLoading } = useConversationAssets(conversationId);
  const visible = filterAssetId ? assets.filter(a => a.id === filterAssetId) : assets;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-none flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold">Generate in ⏱ Chat History</h3>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <button className="hover:text-foreground">Filter</button>
          <button className="hover:text-foreground">View</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing generated in this conversation yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {visible.map(asset => (
              <AssetCard key={asset.id} asset={asset} onClick={() => onCardClick(asset, assets)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
