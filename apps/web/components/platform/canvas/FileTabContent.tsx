'use client';

import { Download, Maximize2, Minimize2, X } from 'lucide-react';
import { useAssetUrl, useMarkdownContent, AssetPreviewBody } from './AssetPreview';
import type { Asset } from '@/types/assets';

interface FileTabContentProps {
  asset: Asset;
  isExpanded?: boolean;
  onExpand?: () => void;
  onClose: () => void;
}

/**
 * What a canvas "file" tab actually shows now — the document itself, not a
 * one-item AssetGallery grid the user then had to click again to open
 * anything. Download/Expand/Close mirror the reference: expand reuses the
 * canvas's own full-width toggle (isExpanded/onExpand, already wired for the
 * browser-automation viewer) rather than opening a second, separate
 * fullscreen surface.
 */
export function FileTabContent({ asset, isExpanded, onExpand, onClose }: FileTabContentProps) {
  const url = useAssetUrl(asset);
  const markdownContent = useMarkdownContent(asset, url);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-none flex items-center justify-between px-4 py-2.5 border-b border-border">
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate">{asset.filename}</p>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{asset.type}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {url && (
            <a
              href={url}
              download={asset.filename}
              target="_blank"
              rel="noopener noreferrer"
              title="Download"
              className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50"
            >
              <Download className="h-4 w-4" />
            </a>
          )}
          {onExpand && (
            <button onClick={onExpand} title={isExpanded ? "Collapse" : "Expand"} className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50">
              {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
          )}
          <button onClick={onClose} title="Close" className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="relative flex-1 flex items-center justify-center overflow-y-auto p-6">
        <AssetPreviewBody asset={asset} url={url} markdownContent={markdownContent} compact />
      </div>
    </div>
  );
}
