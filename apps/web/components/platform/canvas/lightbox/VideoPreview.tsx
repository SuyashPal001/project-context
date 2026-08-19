'use client';

export function VideoPreview({ url }: { url: string }) {
  return (
    <video
      src={url}
      controls
      controlsList="nodownload"
      className="max-h-full max-w-full rounded-lg"
    />
  );
}
