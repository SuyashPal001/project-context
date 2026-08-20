'use client';

import { useEffect, useState } from 'react';
import * as mammoth from 'mammoth';

// Mirrors KnowledgeBaseSection.tsx's DOCX preview (mammoth.convertToHtml),
// which there runs on a local File's arrayBuffer at upload time. Here `url`
// is the file's presigned S3 URL — fetched fresh since the gallery loads
// assets from persisted messages, not a live File already in memory.
export function DocxPreview({ url }: { url: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setFailed(false);
    fetch(url)
      .then(res => res.arrayBuffer())
      .then(arrayBuffer => mammoth.convertToHtml({ arrayBuffer }))
      .then(result => { if (!cancelled) setHtml(result.value); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [url]);

  if (failed) {
    return <p className="text-sm text-muted-foreground">Couldn&apos;t render a preview for this file.</p>;
  }
  if (!html) {
    return <p className="text-sm text-muted-foreground">Loading preview…</p>;
  }
  return (
    <div className="w-full h-full overflow-y-auto bg-white rounded-md shadow-xl p-8">
      <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
