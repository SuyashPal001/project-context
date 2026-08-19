'use client';

export function ImagePreview({ url, alt }: { url: string; alt: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} className="max-h-full max-w-full rounded-lg object-contain" />;
}
