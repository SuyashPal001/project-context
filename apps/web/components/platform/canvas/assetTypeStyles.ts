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

// Card styling for types with no real per-file thumbnail (audio, pdf, docx) —
// a consistent tinted background + icon color instead of the plain flat
// background used for a genuinely missing/unresolved thumbnail, so it reads
// as an intentional design rather than a broken preview.
//
// Shared with the Drive grid (FileGridView) so the same file looks the same
// wherever it is listed.
export const NO_PREVIEW_STYLES: Partial<Record<AssetType, { bg: string; icon: string }>> = {
  audio: { bg: 'bg-gradient-to-br from-violet-500/20 via-fuchsia-500/10 to-muted', icon: 'text-violet-400' },
  pdf: { bg: 'bg-gradient-to-br from-red-500/20 via-orange-500/10 to-muted', icon: 'text-red-400' },
  docx: { bg: 'bg-gradient-to-br from-blue-500/20 via-sky-500/10 to-muted', icon: 'text-blue-400' },
};
