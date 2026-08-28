'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { X, ChevronLeft, ChevronRight, Download, File as FileIcon, Info } from 'lucide-react';
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
  /** Slot beside the close button. Drive puts "Add to chat" here; the chat
   *  canvas leaves it empty, since an asset there is already in a chat. */
  headerActions?: ReactNode;
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

            {url && asset.type === 'video' && <VideoPreview url={url} />}
            {url && asset.type === 'audio' && <AudioPreview url={url} />}
            {url && asset.type === 'image' && <ImagePreview url={url} alt={asset.filename} />}
            {url && asset.type === 'pdf' && <PdfPreview url={url} />}
            {url && asset.type === 'docx' && <DocxPreview url={url} size={asset.size} />}
            {(asset.type === 'markdown' || asset.type === 'prd' || asset.type === 'roadmap' || asset.type === 'tasks') && markdownContent && (
              // Scoped size bump for this full-screen view only — MarkdownViewer's
              // own defaults (h1 at text-base etc.) stay small on purpose for the
              // narrower contexts it's also used in (inline chat, ArtifactPanel's
              // side column). Descendant overrides here don't touch those.
              <div className="w-full h-full max-w-3xl overflow-y-auto text-base leading-relaxed px-2 [&_h1]:text-4xl [&_h1]:mb-4 [&_h1]:mt-0 [&_h2]:text-2xl [&_h2]:mt-8 [&_h2]:mb-3 [&_h3]:text-lg [&_h3]:mt-6">
                {/* Not every generated document opens with its own "# Heading" —
                    without one, the reader just starts mid-paragraph with nothing
                    tying it back to what it is. Falls back to a title derived from
                    the filename so the page always has an anchor, skipped when the
                    content already supplies its own H1. */}
                {!markdownContent.trimStart().startsWith('#') && (
                  <h1 className="text-4xl font-bold mb-4">
                    {asset.filename.replace(/\.[^/.]+$/, '').replace(/[-_]+/g, ' ')}
                  </h1>
                )}
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
            {(asset.type === 'file' || asset.type === 'csv') && (
              // Nothing here can render a .zip or a spreadsheet — say so rather than
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
