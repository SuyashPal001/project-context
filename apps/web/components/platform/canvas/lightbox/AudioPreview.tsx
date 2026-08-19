'use client';

import { useEffect, useRef, useState } from 'react';
import { Play, Pause, RotateCcw, RotateCw } from 'lucide-react';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function AudioPreview({ url }: { url: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onLoadedMetadata = () => setDuration(audio.duration);
    const onEnded = () => setIsPlaying(false);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
    };
  }, [url]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) audio.pause(); else audio.play();
    setIsPlaying(!isPlaying);
  };

  const skip = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + seconds));
  };

  const progress = duration > 0 ? currentTime / duration : 0;

  return (
    <div className="flex flex-col items-center gap-4 w-full max-w-md">
      <audio ref={audioRef} src={url} />
      <div className="w-full h-16 rounded-lg bg-muted flex items-center px-3 gap-0.5 overflow-hidden">
        {Array.from({ length: 48 }).map((_, i) => (
          <div
            key={i}
            className={`flex-1 rounded-full ${i / 48 < progress ? 'bg-primary' : 'bg-border'}`}
            style={{ height: `${20 + Math.sin(i * 0.7) * 15}px` }}
          />
        ))}
      </div>
      <div className="flex items-center gap-4">
        <button onClick={() => skip(-10)} className="h-8 w-8 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/50">
          <RotateCcw className="h-4 w-4" />
        </button>
        <button onClick={togglePlay} className="h-11 w-11 flex items-center justify-center rounded-full bg-primary text-primary-foreground">
          {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-0.5" />}
        </button>
        <button onClick={() => skip(10)} className="h-8 w-8 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/50">
          <RotateCw className="h-4 w-4" />
        </button>
      </div>
      <p className="text-xs text-muted-foreground">{formatTime(currentTime)} / {formatTime(duration)}</p>
    </div>
  );
}
