'use client';

// Mirrors KnowledgeBaseSection.tsx's PDF preview — the browser's own native
// PDF viewer via <iframe>, no rendering library needed. That version points
// at a local blob URL (URL.createObjectURL) since it previews a file still
// in hand at upload time; here `url` is the file's presigned S3 URL instead,
// since the gallery loads assets from persisted messages, not a live File.
export function PdfPreview({ url }: { url: string }) {
  return (
    <iframe
      src={`${url}#toolbar=0`}
      className="w-full h-full max-w-3xl border-0 rounded-md bg-white shadow-xl"
      title="PDF preview"
    />
  );
}
