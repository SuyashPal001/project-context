'use client';

import { useEffect, useState } from 'react';
import { FileVideo, FileAudio, FileImage, FileText, File as FileIcon, Play } from 'lucide-react';
import { useConversationAssets } from '@/hooks/useConversationAssets';
import { api } from '@/lib/api';
import type { Asset, AssetType } from '@/types/assets';

interface AssetGalleryProps {
  conversationId: string;
  filterAssetId?: string;
  fallbackAsset?: Asset;
  onCardClick: (asset: Asset, allAssets: Asset[]) => void;
}

const TYPE_ICONS: Record<AssetType, React.ElementType> = {
  video: FileVideo,
  audio: FileAudio,
  image: FileImage,
  markdown: FileText,
  pdf: FileText,
  docx: FileText,
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
  pdf: 'PDF',
  docx: 'DOCX',
  file: 'FILE',
  prd: 'PRD',
  roadmap: 'ROADMAP',
  tasks: 'TASKS',
};

const TYPE_FILTER_LABELS: Record<AssetType, string> = {
  video: 'Video',
  audio: 'Audio',
  image: 'Image',
  markdown: 'Markdown',
  pdf: 'PDF',
  docx: 'DOCX',
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

// Grabs one frame from a video URL via a hidden <video>+<canvas>, entirely
// client-side — no backend/ffmpeg work needed. Seeks to 1s (or the video's
// midpoint if shorter) rather than frame 0, since many videos open on a
// black/blank frame. Resolves undefined on any failure (unsupported codec,
// load timeout, or a canvas read blocked by the bucket's CORS policy) so
// the card falls back to the existing icon placeholder rather than erroring.
function captureVideoFrame(videoUrl: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    let settled = false;
    const finish = (result: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.remove();
      resolve(result);
    };
    const timer = setTimeout(() => finish(undefined), 8000);

    video.addEventListener('loadedmetadata', () => {
      video.currentTime = Number.isFinite(video.duration) ? Math.min(1, video.duration / 2) : 0;
    });
    video.addEventListener('seeked', () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        if (canvas.width === 0 || canvas.height === 0) return finish(undefined);
        const ctx = canvas.getContext('2d');
        if (!ctx) return finish(undefined);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', 0.7));
      } catch {
        finish(undefined);
      }
    });
    video.addEventListener('error', () => finish(undefined));

    video.src = videoUrl;
  });
}

function useVideoFrameThumbnail(asset: Asset): string | undefined {
  const [frameUrl, setFrameUrl] = useState<string | undefined>();
  useEffect(() => {
    if (asset.type !== 'video' || !asset.fileId) return;
    let cancelled = false;
    api.get<{ presignedUrl: string }>(`/api/v1/files/${encodeURIComponent(asset.fileId)}/presigned-url`)
      .then(res => captureVideoFrame(res.presignedUrl))
      .then(dataUrl => { if (!cancelled && dataUrl) setFrameUrl(dataUrl); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [asset.type, asset.fileId]);
  return frameUrl;
}

// Card styling for types with no real per-file thumbnail (audio, pdf, docx) —
// a consistent tinted background + icon color instead of the plain flat
// background used for a genuinely missing/unresolved thumbnail, so it reads
// as an intentional design rather than a broken preview.
const NO_PREVIEW_STYLES: Partial<Record<AssetType, { bg: string; icon: string }>> = {
  audio: { bg: 'bg-gradient-to-br from-violet-500/20 via-fuchsia-500/10 to-muted', icon: 'text-violet-400' },
  pdf: { bg: 'bg-gradient-to-br from-red-500/20 via-orange-500/10 to-muted', icon: 'text-red-400' },
  docx: { bg: 'bg-gradient-to-br from-blue-500/20 via-sky-500/10 to-muted', icon: 'text-blue-400' },
};

function AssetCard({ asset, onClick }: { asset: Asset; onClick: () => void }) {
  const Icon = TYPE_ICONS[asset.type];
  const imageThumbnailUrl = useThumbnailUrl(asset);
  const videoFrameUrl = useVideoFrameThumbnail(asset);
  const thumbnailUrl = imageThumbnailUrl ?? videoFrameUrl;
  const noPreviewStyle = NO_PREVIEW_STYLES[asset.type];
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
        <div className={`relative aspect-video flex items-center justify-center ${noPreviewStyle?.bg ?? 'bg-muted'}`}>
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
            <Icon className={`h-8 w-8 ${noPreviewStyle?.icon ?? 'text-muted-foreground/60'}`} />
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
