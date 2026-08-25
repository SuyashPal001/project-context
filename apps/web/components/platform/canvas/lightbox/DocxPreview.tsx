'use client';

import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';

// Mirrors KnowledgeBaseSection.tsx's DOCX preview (mammoth.convertToHtml),
// which there runs on a local File's arrayBuffer at upload time. Here `url`
// is the file's presigned S3 URL — fetched fresh since the gallery loads
// assets from persisted messages, not a live File already in memory.
//
// The actual conversion runs in docxConvertWorker.ts, off the main thread —
// mammoth's parse + its default full-res base64 image inlining is slow
// enough on a large, image-heavy .docx to freeze the tab otherwise. Files
// above MAX_INLINE_PREVIEW_BYTES skip conversion entirely rather than make
// the user wait on a browser tab that looks hung.
const MAX_INLINE_PREVIEW_BYTES = 15 * 1024 * 1024;

export function DocxPreview({ url, size }: { url: string; size?: number }) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const tooLarge = size != null && size > MAX_INLINE_PREVIEW_BYTES;

  useEffect(() => {
    if (tooLarge) return;
    let cancelled = false;
    setHtml(null);
    setFailed(false);

    const worker = new Worker(new URL('./docxConvertWorker.ts', import.meta.url));
    worker.onmessage = (event: MessageEvent<{ html?: string; error?: boolean }>) => {
      if (cancelled) return;
      if (event.data.error || typeof event.data.html !== 'string') {
        setFailed(true);
      } else {
        setHtml(event.data.html);
      }
    };
    worker.onerror = () => { if (!cancelled) setFailed(true); };

    fetch(url)
      .then(res => res.arrayBuffer())
      .then(arrayBuffer => worker.postMessage(arrayBuffer, [arrayBuffer]))
      .catch(() => { if (!cancelled) setFailed(true); });

    return () => { cancelled = true; worker.terminate(); };
  }, [url, tooLarge]);

  if (tooLarge) {
    return (
      <div className="text-sm text-muted-foreground text-center max-w-xs space-y-2">
        <p>This document is too large to preview inline ({(size! / 1024 / 1024).toFixed(1)} MB).</p>
        <a href={url} download className="inline-flex items-center gap-1.5 text-shimmer-accent hover:underline">
          <Download className="h-3.5 w-3.5" />
          Download to view
        </a>
      </div>
    );
  }
  if (failed) {
    return <p className="text-sm text-muted-foreground">Couldn&apos;t render a preview for this file.</p>;
  }
  if (!html) {
    return <p className="text-sm text-muted-foreground">Loading preview…</p>;
  }
  return (
    <div className="w-full h-full max-w-3xl overflow-y-auto bg-white rounded-md shadow-xl p-8 text-black">
      <div className="prose prose-sm max-w-none prose-zinc" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
