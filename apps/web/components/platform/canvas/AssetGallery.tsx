'use client';

import { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { useConversationAssets } from '@/hooks/useConversationAssets';
import { api } from '@/lib/api';
import type { Asset, AssetType } from '@/types/assets';
import { TYPE_ICONS, TYPE_BADGES, TYPE_STYLES } from './assetTypeStyles';
import { useVideoFrameThumbnail } from './videoFrameThumbnail';

interface AssetGalleryProps {
  conversationId: string;
  filterAssetId?: string;
  fallbackAsset?: Asset;
  onCardClick: (asset: Asset, allAssets: Asset[]) => void;
}

const TYPE_FILTER_LABELS: Record<AssetType, string> = {
  video: 'Video',
  audio: 'Audio',
  image: 'Image',
  markdown: 'Markdown',
  pdf: 'PDF',
  docx: 'DOCX',
  csv: 'CSV',
  file: 'File',
  prd: 'PRD',
  roadmap: 'Roadmap',
  tasks: 'Tasks',
};

// The `/assets` list endpoint never returns a thumbnailUrl (it would mean
// presigning every image on every gallery fetch) — resolve one lazily per
// card instead, mirroring AssetLightbox's useAssetUrl. Without this, cards
// that arrive via the fallback asset (which does carry a live URL) lose
// their thumbnail for good the moment the real query data replaces it.
function useThumbnailUrl(asset: Asset): string | undefined {
  const [url, setUrl] = useState<string | undefined>(asset.thumbnailUrl);
  useEffect(() => {
    setUrl(asset.thumbnailUrl);
    if (asset.thumbnailUrl || asset.type !== 'image' || !asset.fileId) return;
    let cancelled = false;
    api.get<{ presignedUrl: string }>(`/api/v1/files/${encodeURIComponent(asset.fileId)}/presigned-url`)
      .then(res => { if (!cancelled) setUrl(res.presignedUrl); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [asset.thumbnailUrl, asset.type, asset.fileId]);
  return url;
}

function AssetCard({ asset, onClick }: { asset: Asset; onClick: () => void }) {
  const Icon = TYPE_ICONS[asset.type];
  const imageThumbnailUrl = useThumbnailUrl(asset);
  const videoFrameUrl = useVideoFrameThumbnail(asset.fileId, asset.type === 'video');
  const thumbnailUrl = imageThumbnailUrl ?? videoFrameUrl;
  const typeStyle = TYPE_STYLES[asset.type];
  return (
    <div className="group relative flex flex-col rounded-xl border border-border/60 bg-muted/20 overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        }}
        className="text-left hover:border-primary/40 transition-colors"
      >
        <div className={`relative aspect-video flex items-center justify-center ${typeStyle.bg}`}>
          {thumbnailUrl ? (
            <>
              <img src={thumbnailUrl} alt={asset.filename} className="w-full h-full object-cover" />
              {asset.type === 'video' && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="h-8 w-8 rounded-full bg-black/50 flex items-center justify-center">
                    <Play className="h-4 w-4 text-white fill-white" />
                  </div>
                </div>
              )}
            </>
          ) : (
            <Icon className={`h-8 w-8 ${typeStyle.icon}`} />
          )}
          <span className="absolute top-1.5 left-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-background/90 border border-border/60">
            {TYPE_BADGES[asset.type]}
          </span>
          {asset.fileId && (
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
          )}
        </div>
        <div className="px-2.5 py-2">
          <p className="text-xs font-medium truncate">{asset.filename}</p>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{asset.type}</p>
        </div>
      </div>
    </div>
  );
}

export function AssetGallery({ conversationId, filterAssetId, fallbackAsset, onCardClick }: AssetGalleryProps) {
  const { assets, isLoading } = useConversationAssets(conversationId);
  const [typeFilter, setTypeFilter] = useState<AssetType | 'all'>('all');
  useEffect(() => { setTypeFilter('all'); }, [conversationId]);

  const availableTypes = Array.from(new Set(assets.map(a => a.type)));
  const typeFiltered = typeFilter === 'all' ? assets : assets.filter(a => a.type === typeFilter);
  const visible = filterAssetId ? assets.filter(a => a.id === filterAssetId) : typeFiltered;
  const showFallback = filterAssetId && visible.length === 0 && !!fallbackAsset;

  return (
    <div className="flex flex-col h-full">
      <div className="flex-none px-4 py-3 border-b border-border space-y-2">
        <h3 className="text-sm font-semibold">Chat History</h3>
        {!filterAssetId && availableTypes.length > 1 && (
          <div className="flex items-center gap-1.5 overflow-x-auto">
            <button
              onClick={() => setTypeFilter('all')}
              className={`shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full border transition-colors ${
                typeFilter === 'all' ? 'bg-primary text-primary-foreground border-primary' : 'text-muted-foreground border-border hover:text-foreground'
              }`}
            >
              All
            </button>
            {availableTypes.map(type => (
              <button
                key={type}
                onClick={() => setTypeFilter(type)}
                className={`shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full border transition-colors ${
                  typeFilter === type ? 'bg-primary text-primary-foreground border-primary' : 'text-muted-foreground border-border hover:text-foreground'
                }`}
              >
                {TYPE_FILTER_LABELS[type]}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : showFallback ? (
          <div className="grid grid-cols-2 gap-3">
            <AssetCard asset={fallbackAsset} onClick={() => onCardClick(fallbackAsset, [fallbackAsset])} />
          </div>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {typeFilter === 'all'
              ? 'Nothing generated in this conversation yet.'
              : `No ${TYPE_FILTER_LABELS[typeFilter].toLowerCase()} files in this conversation.`}
          </p>
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
