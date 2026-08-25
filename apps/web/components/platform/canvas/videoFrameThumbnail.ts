'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

// Grabs one frame from a video URL via a hidden <video>+<canvas>, entirely
// client-side — no backend/ffmpeg work needed. Seeks to 1s (or the video's
// midpoint if shorter) rather than frame 0, since many videos open on a
// black/blank frame. Resolves undefined on any failure (unsupported codec,
// load timeout, or a canvas read blocked by the bucket's CORS policy) so
// the card falls back to the existing icon placeholder rather than erroring.
function captureVideoFrame(videoUrl: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    let settled = false;
    const finish = (result: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.remove();
      resolve(result);
    };
    const timer = setTimeout(() => finish(undefined), 8000);

    video.addEventListener('loadedmetadata', () => {
      video.currentTime = Number.isFinite(video.duration) ? Math.min(1, video.duration / 2) : 0;
    });
    video.addEventListener('seeked', () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        if (canvas.width === 0 || canvas.height === 0) return finish(undefined);
        const ctx = canvas.getContext('2d');
        if (!ctx) return finish(undefined);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', 0.7));
      } catch {
        finish(undefined);
      }
    });
    video.addEventListener('error', () => finish(undefined));

    video.src = videoUrl;
  });
}

export function useVideoFrameThumbnail(fileId: string | undefined, enabled: boolean): string | undefined {
  const [frameUrl, setFrameUrl] = useState<string | undefined>();
  useEffect(() => {
    if (!enabled || !fileId) return;
    let cancelled = false;
    api.get<{ presignedUrl: string }>(`/api/v1/files/${encodeURIComponent(fileId)}/presigned-url`)
      .then(res => captureVideoFrame(res.presignedUrl))
      .then(dataUrl => { if (!cancelled && dataUrl) setFrameUrl(dataUrl); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [enabled, fileId]);
  return frameUrl;
}
