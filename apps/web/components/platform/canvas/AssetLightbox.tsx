'use client';

import { type ReactNode } from 'react';
import { X, ChevronLeft, ChevronRight, Download, Info } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useAssetUrl, useMarkdownContent, AssetPreviewBody } from './AssetPreview';
import type { Asset } from '@/types/assets';

interface AssetLightboxProps {
  asset: Asset;
  allAssets: Asset[];
  onClose: () => void;
  onNavigate: (asset: Asset) => void;
  /** Slot beside the close button. Drive puts "Add to chat" here; the chat
   *  canvas leaves it empty, since an asset there is already in a chat. */
  headerActions?: ReactNode;
}

export function AssetLightbox({ asset, allAssets, onClose, onNavigate, headerActions }: AssetLightboxProps) {
  const url = useAssetUrl(asset);
  const markdownContent = useMarkdownContent(asset, url);
  const index = allAssets.findIndex(a => a.id === asset.id);
  const prevAsset = index > 0 ? allAssets[index - 1] : null;
  const nextAsset = index >= 0 && index < allAssets.length - 1 ? allAssets[index + 1] : null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={false} className="max-w-none w-screen h-screen p-0 rounded-none border-0 sm:max-w-none flex flex-col">
        <div className="flex-none flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <DialogTitle className="text-sm font-semibold">{asset.filename}</DialogTitle>
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide">{asset.type}</p>
          </div>
          <div className="flex items-center gap-2">
            {headerActions}
            <button onClick={onClose} className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          <div className="relative flex-1 flex items-center justify-center bg-black/5 p-6">
            {prevAsset && (
              <button
                onClick={() => onNavigate(prevAsset)}
                className="absolute left-4 top-1/2 -translate-y-1/2 h-9 w-9 flex items-center justify-center rounded-full bg-background/90 border border-border shadow-sm hover:bg-background"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}

            <AssetPreviewBody asset={asset} url={url} markdownContent={markdownContent} />

            {nextAsset && (
              <button
                onClick={() => onNavigate(nextAsset)}
                className="absolute right-4 top-1/2 -translate-y-1/2 h-9 w-9 flex items-center justify-center rounded-full bg-background/90 border border-border shadow-sm hover:bg-background"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="w-72 flex-none border-l border-border bg-muted/20 p-5 flex flex-col">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-4">
              <Info className="h-3 w-3" />
              Details
            </div>
            <div className="space-y-4 text-xs">
              <div>
                <p className="text-muted-foreground">Type</p>
                <p className="font-medium mt-0.5">{asset.type}</p>
              </div>
              {asset.size != null && (
                <div>
                  <p className="text-muted-foreground">Size</p>
                  <p className="font-medium mt-0.5">{(asset.size / 1024 / 1024).toFixed(2)} MB</p>
                </div>
              )}
              <div>
                <p className="text-muted-foreground">Created</p>
                <p className="font-medium mt-0.5">{new Date(asset.createdAt).toLocaleString()}</p>
              </div>
            </div>
            <div className="flex-1" />
            {url && (
              <a
                href={url}
                download={asset.filename}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 rounded-full bg-gradient-to-br from-[#E69DB8] to-[#F2A679] text-black font-semibold text-sm py-2.5 shadow-sm hover:opacity-90 transition-opacity"
              >
                <Download className="h-4 w-4" />
                Download
              </a>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
