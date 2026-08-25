'use client';

import { useEffect, useState } from 'react';
import { X, ChevronLeft, ChevronRight, Copy, Download, File as FileIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { VideoPreview } from './lightbox/VideoPreview';
import { AudioPreview } from './lightbox/AudioPreview';
import { ImagePreview } from './lightbox/ImagePreview';
import { PdfPreview } from './lightbox/PdfPreview';
import { DocxPreview } from './lightbox/DocxPreview';
import { MarkdownViewer } from './MarkdownViewer';
import type { Asset } from '@/types/assets';

interface AssetLightboxProps {
  asset: Asset;
  allAssets: Asset[];
  onClose: () => void;
  onNavigate: (asset: Asset) => void;
}

function useAssetUrl(asset: Asset): string | null {
  const [url, setUrl] = useState<string | null>(asset.thumbnailUrl ?? null);
  useEffect(() => {
    let cancelled = false;
    setUrl(asset.thumbnailUrl ?? null);
    if (!asset.fileId) return;
    api.get<{ presignedUrl: string }>(`/api/v1/files/${encodeURIComponent(asset.fileId)}/presigned-url`)
      .then(res => { if (!cancelled) setUrl(res.presignedUrl); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [asset.fileId, asset.thumbnailUrl]);
  return url;
}

function useMarkdownContent(asset: Asset, fileUrl: string | null): string {
  const [content, setContent] = useState('');
  useEffect(() => {
    setContent('');
    let cancelled = false;
    if (asset.type === 'tasks') {
      // Task-list artifacts only ever arrive via the live streaming payload
      // (artifact_load's inline content/chunk). There is no REST endpoint to
      // fetch them on demand, so leave content empty and let the render
      // branch below show an explanatory message instead of a blank pane.
    } else if (asset.type === 'markdown' && fileUrl) {
      fetch(fileUrl).then(r => r.text()).then(text => { if (!cancelled) setContent(text); }).catch(() => {});
    } else if (asset.type === 'prd' && asset.entityId) {
      api.get<{ data: { content: string } }>(`/api/v1/prds/${asset.entityId}`)
        .then(res => { if (!cancelled) setContent(res.data?.content ?? ''); })
        .catch(() => {});
    } else if (asset.type === 'roadmap' && asset.entityId) {
      Promise.all([
        api.get<{ data: { title: string; description?: string | null } }>(`/api/v1/plans/${asset.entityId}`),
        api.get<{ data: Array<{ title: string; description?: string | null; priority: string }> }>(`/api/v1/plans/${asset.entityId}/milestones`),
      ]).then(([planRes, msRes]) => {
        if (cancelled) return;
        const plan = planRes.data;
        const milestones = msRes.data ?? [];
        const lines: string[] = [`# ${plan.title}`];
        if (plan.description) lines.push(`\n${plan.description}\n`);
        milestones.forEach((m, i) => {
          lines.push(`### ${i + 1}. ${m.title}`);
          lines.push(`**Priority:** ${m.priority}`);
          if (m.description) lines.push(`\n${m.description}`);
        });
        setContent(lines.join('\n'));
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [asset.id, asset.type, asset.entityId, fileUrl]);
  return content;
}

export function AssetLightbox({ asset, allAssets, onClose, onNavigate }: AssetLightboxProps) {
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
            <button className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50">
              <Copy className="h-4 w-4" />
            </button>
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

            {url && asset.type === 'video' && <VideoPreview url={url} />}
            {url && asset.type === 'audio' && <AudioPreview url={url} />}
            {url && asset.type === 'image' && <ImagePreview url={url} alt={asset.filename} />}
            {url && asset.type === 'pdf' && <PdfPreview url={url} />}
            {url && asset.type === 'docx' && <DocxPreview url={url} size={asset.size} />}
            {(asset.type === 'markdown' || asset.type === 'prd' || asset.type === 'roadmap' || asset.type === 'tasks') && markdownContent && (
              <div className="w-full h-full max-w-3xl overflow-y-auto text-sm px-2">
                <MarkdownViewer content={markdownContent} />
              </div>
            )}
            {asset.type === 'tasks' && !markdownContent && (
              <p className="text-sm text-muted-foreground max-w-sm text-center">
                Task list content is only available while it&apos;s actively being generated in the chat — it can&apos;t be reloaded here yet.
              </p>
            )}
            {!url && (asset.type === 'video' || asset.type === 'audio' || asset.type === 'image' || asset.type === 'pdf' || asset.type === 'docx') && (
              <p className="text-sm text-muted-foreground">Loading preview…</p>
            )}
            {asset.type === 'file' && (
              // Nothing here can render a .zip or .csv — say so rather than
              // opening onto an empty pane. The sidebar's Download still works.
              <div className="flex flex-col items-center gap-2 text-center">
                <FileIcon className="h-8 w-8 text-muted-foreground/50" />
                <p className="text-sm font-medium">{asset.filename}</p>
                <p className="text-sm text-muted-foreground">No preview available — download to open it.</p>
              </div>
            )}

            {nextAsset && (
              <button
                onClick={() => onNavigate(nextAsset)}
                className="absolute right-4 top-1/2 -translate-y-1/2 h-9 w-9 flex items-center justify-center rounded-full bg-background/90 border border-border shadow-sm hover:bg-background"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="w-64 flex-none border-l border-border p-4 space-y-3 text-xs">
            <div>
              <p className="text-muted-foreground">Type</p>
              <p className="font-medium">{asset.type}</p>
            </div>
            {asset.size != null && (
              <div>
                <p className="text-muted-foreground">Size</p>
                <p className="font-medium">{(asset.size / 1024 / 1024).toFixed(2)} MB</p>
              </div>
            )}
            <div>
              <p className="text-muted-foreground">Created</p>
              <p className="font-medium">{new Date(asset.createdAt).toLocaleString()}</p>
            </div>
            {url && (
              <a
                href={url}
                download={asset.filename}
                target="_blank"
                rel="noopener noreferrer"
                // text-shimmer-accent, not text-primary: the pale rose --primary
                // fails WCAG AA as body text on the light theme (see globals.css).
                className="flex items-center gap-1.5 mt-2 text-shimmer-accent hover:underline"
              >
                <Download className="h-3.5 w-3.5" />
                Download
              </a>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
