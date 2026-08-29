'use client';

import { useEffect, useState } from 'react';
import { File as FileIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { VideoPreview } from './lightbox/VideoPreview';
import { AudioPreview } from './lightbox/AudioPreview';
import { ImagePreview } from './lightbox/ImagePreview';
import { PdfPreview } from './lightbox/PdfPreview';
import { DocxPreview } from './lightbox/DocxPreview';
import { MarkdownViewer } from './MarkdownViewer';
import type { Asset } from '@/types/assets';

export function useAssetUrl(asset: Asset): string | null {
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

export function useMarkdownContent(asset: Asset, fileUrl: string | null): string {
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

interface AssetPreviewBodyProps {
  asset: Asset;
  url: string | null;
  markdownContent: string;
  /** The canvas tab embeds this at a smaller scale than the fullscreen
   * lightbox — markdown typography only bumps up in the larger context. */
  compact?: boolean;
}

/**
 * The actual preview content (video/audio/image/pdf/docx/markdown/etc.) shared
 * between the canvas's inline "file" tab and the fullscreen AssetLightbox —
 * split out so a tab can show the real document directly instead of routing
 * through a one-item AssetGallery grid that needed a second click to open
 * anything.
 */
export function AssetPreviewBody({ asset, url, markdownContent, compact }: AssetPreviewBodyProps) {
  return (
    <>
      {url && asset.type === 'video' && <VideoPreview url={url} />}
      {url && asset.type === 'audio' && <AudioPreview url={url} />}
      {url && asset.type === 'image' && <ImagePreview url={url} alt={asset.filename} />}
      {url && asset.type === 'pdf' && <PdfPreview url={url} />}
      {url && asset.type === 'docx' && <DocxPreview url={url} size={asset.size} />}
      {(asset.type === 'markdown' || asset.type === 'prd' || asset.type === 'roadmap' || asset.type === 'tasks') && markdownContent && (
        <div className={
          compact
            ? "w-full h-full max-w-3xl overflow-y-auto text-sm leading-relaxed px-2 [&_h1]:text-2xl [&_h1]:mb-3 [&_h1]:mt-0 [&_h2]:text-lg [&_h2]:mt-5 [&_h2]:mb-2 [&_h3]:text-base [&_h3]:mt-4"
            : "w-full h-full max-w-3xl overflow-y-auto text-base leading-relaxed px-2 [&_h1]:text-4xl [&_h1]:mb-4 [&_h1]:mt-0 [&_h2]:text-2xl [&_h2]:mt-8 [&_h2]:mb-3 [&_h3]:text-lg [&_h3]:mt-6"
        }>
          {/* Not every generated document opens with its own "# Heading" —
              without one, the reader just starts mid-paragraph with nothing
              tying it back to what it is. Falls back to a title derived from
              the filename so the page always has an anchor, skipped when the
              content already supplies its own H1. */}
          {!markdownContent.trimStart().startsWith('#') && (
            <h1 className={compact ? "text-2xl font-bold mb-3" : "text-4xl font-bold mb-4"}>
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
        // opening onto an empty pane. Download still works from the header.
        <div className="flex flex-col items-center gap-2 text-center">
          <FileIcon className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm font-medium">{asset.filename}</p>
          <p className="text-sm text-muted-foreground">No preview available — download to open it.</p>
        </div>
      )}
    </>
  );
}
