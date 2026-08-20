'use client';

import { useEffect, useRef, useState } from 'react';
import { Play, Pause, RotateCcw, RotateCw } from 'lucide-react';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const WAVEFORM_BARS = 96;

// Decodes the actual audio samples to build a real waveform (peak amplitude
// per bar), rather than a decorative placeholder pattern.
async function computeWaveformPeaks(url: string, bars: number): Promise<number[]> {
  const res = await fetch(url);
  const arrayBuffer = await res.arrayBuffer();
  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioContext = new AudioContextCtor();
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const channelData = audioBuffer.getChannelData(0);
    const samplesPerBar = Math.max(1, Math.floor(channelData.length / bars));
    const peaks: number[] = [];
    for (let i = 0; i < bars; i++) {
      const start = i * samplesPerBar;
      let max = 0;
      for (let j = 0; j < samplesPerBar; j++) {
        const value = Math.abs(channelData[start + j] ?? 0);
        if (value > max) max = value;
      }
      peaks.push(max);
    }
    const maxPeak = Math.max(...peaks, 0.01);
    return peaks.map(p => p / maxPeak);
  } finally {
    audioContext.close();
  }
}

export function AudioPreview({ url }: { url: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [peaks, setPeaks] = useState<number[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPeaks(null);
    computeWaveformPeaks(url, WAVEFORM_BARS)
      .then(result => { if (!cancelled) setPeaks(result); })
      .catch(() => { if (!cancelled) setPeaks(Array(WAVEFORM_BARS).fill(0.3)); });
    return () => { cancelled = true; };
  }, [url]);

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
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
      return;
    }
    // audio.play() returns a promise that can reject (blocked/unsupported
    // format) — only flip to "playing" once it actually resolves, so the
    // button never lies about playback state.
    audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
  };

  const skip = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + seconds));
  };

  const seekToRatio = (ratio: number) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    audio.currentTime = Math.max(0, Math.min(duration, ratio * duration));
  };

  const progress = duration > 0 ? currentTime / duration : 0;

  return (
    <div className="flex flex-col items-center gap-6 w-full max-w-3xl px-8">
      <audio ref={audioRef} src={url} />
      <p className="text-sm font-medium">
        <span className="text-foreground">{formatTime(currentTime)}</span>
        <span className="text-muted-foreground"> / {formatTime(duration)}</span>
      </p>
      <div
        className="relative w-full h-24 flex items-center gap-[3px] cursor-pointer"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          seekToRatio((e.clientX - rect.left) / rect.width);
        }}
      >
        {(peaks ?? Array(WAVEFORM_BARS).fill(0.15)).map((peak, i) => (
          <div
            key={i}
            className={`flex-1 rounded-full ${i / WAVEFORM_BARS < progress ? 'bg-foreground' : 'bg-muted-foreground/30'}`}
            style={{ height: `${Math.max(8, peak * 100)}%` }}
          />
        ))}
        {duration > 0 && (
          <div className="absolute top-0 h-full w-px bg-primary" style={{ left: `${progress * 100}%` }} />
        )}
      </div>
      <div className="flex items-center gap-6">
        <button onClick={() => skip(-10)} className="flex flex-col items-center gap-0.5 text-muted-foreground hover:text-foreground">
          <RotateCcw className="h-5 w-5" />
          <span className="text-[10px]">10</span>
        </button>
        <button onClick={togglePlay} className="h-14 w-14 flex items-center justify-center rounded-full bg-primary text-primary-foreground">
          {isPlaying ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6 ml-0.5" />}
        </button>
        <button onClick={() => skip(10)} className="flex flex-col items-center gap-0.5 text-muted-foreground hover:text-foreground">
          <RotateCw className="h-5 w-5" />
          <span className="text-[10px]">10</span>
        </button>
      </div>
    </div>
  );
}
