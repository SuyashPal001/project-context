import { FileText, Image as ImageIcon, Video, Music, FileCode, File } from "lucide-react";

export function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function getFileIcon(contentType: string) {
    if (contentType.includes('pdf')) return <FileText className="w-4 h-4 text-muted-foreground" />;
    if (contentType.includes('image')) return <ImageIcon className="w-4 h-4 text-muted-foreground" />;
    if (contentType.includes('video')) return <Video className="w-4 h-4 text-muted-foreground" />;
    if (contentType.includes('audio')) return <Music className="w-4 h-4 text-muted-foreground" />;
    if (contentType.includes('text') || contentType.includes('json') || contentType.includes('javascript')) return <FileCode className="w-4 h-4 text-muted-foreground" />;
    return <File className="w-4 h-4 text-muted-foreground" />;
}
