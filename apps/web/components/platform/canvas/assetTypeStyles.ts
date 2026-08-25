import { FileVideo, FileAudio, FileImage, FileText, File as FileIcon } from 'lucide-react';
import type { AssetType } from '@/types/assets';

export const TYPE_ICONS: Record<AssetType, React.ElementType> = {
  video: FileVideo,
  audio: FileAudio,
  image: FileImage,
  markdown: FileText,
  pdf: FileText,
  docx: FileText,
  file: FileIcon,
  prd: FileText,
  roadmap: FileText,
  tasks: FileText,
};

export const TYPE_BADGES: Record<AssetType, string> = {
  video: 'MP4',
  audio: 'MP3',
  image: 'IMG',
  markdown: 'MD',
  pdf: 'PDF',
  docx: 'DOCX',
  file: 'FILE',
  prd: 'PRD',
  roadmap: 'ROADMAP',
  tasks: 'TASKS',
};

// Per-type tinted background + icon color. Every type gets one so a tile is
// never a flat grey square: for audio/pdf/docx/markdown it *is* the preview,
// and for image/video it sits behind the thumbnail as the surface it loads
// onto (and stays visible if that thumbnail never resolves).
//
// Shared with the Drive grid (FileGridView) so the same file looks the same
// wherever it is listed. Record, not Partial: a new AssetType has to declare
// its own styling rather than silently falling back to grey.
export const TYPE_STYLES: Record<AssetType, { bg: string; icon: string }> = {
  audio: { bg: 'bg-gradient-to-br from-violet-500/20 via-fuchsia-500/10 to-muted', icon: 'text-violet-400' },
  pdf: { bg: 'bg-gradient-to-br from-red-500/20 via-orange-500/10 to-muted', icon: 'text-red-400' },
  docx: { bg: 'bg-gradient-to-br from-blue-500/20 via-sky-500/10 to-muted', icon: 'text-blue-400' },
  image: { bg: 'bg-gradient-to-br from-emerald-500/20 via-teal-500/10 to-muted', icon: 'text-emerald-400' },
  video: { bg: 'bg-gradient-to-br from-amber-500/20 via-orange-500/10 to-muted', icon: 'text-amber-400' },
  markdown: { bg: 'bg-gradient-to-br from-slate-500/20 via-slate-400/10 to-muted', icon: 'text-slate-400' },
  file: { bg: 'bg-gradient-to-br from-zinc-500/15 via-zinc-400/10 to-muted', icon: 'text-zinc-400' },
  prd: { bg: 'bg-gradient-to-br from-indigo-500/20 via-blue-500/10 to-muted', icon: 'text-indigo-400' },
  roadmap: { bg: 'bg-gradient-to-br from-purple-500/20 via-fuchsia-500/10 to-muted', icon: 'text-purple-400' },
  tasks: { bg: 'bg-gradient-to-br from-lime-500/20 via-green-500/10 to-muted', icon: 'text-lime-400' },
};
