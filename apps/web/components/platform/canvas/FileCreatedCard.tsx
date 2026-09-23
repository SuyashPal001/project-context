'use client';

import { FileText, FileImage, FileCode, FileSpreadsheet, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface FileCreatedCardProps {
  filePath: string;
  fileType?: string;
  onDownload?: () => void;
}

const fileIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  pdf: FileText,
  docx: FileText,
  doc: FileText,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  js: FileCode,
  ts: FileCode,
  py: FileCode,
  xlsx: FileSpreadsheet,
  csv: FileSpreadsheet,
};

export function FileCreatedCard({ filePath, fileType, onDownload }: FileCreatedCardProps) {
  const extension = fileType ?? filePath.split('.').pop() ?? '';
  const Icon = fileIcons[extension.toLowerCase()] ?? FileText;
  const fileName = filePath.split('/').pop() ?? filePath;

  return (
    <div className="flex items-center gap-3 p-3 bg-muted rounded-lg border border-border">
      <div className="p-2 bg-primary/10 rounded">
        <Icon className="h-5 w-5 text-primary" />
      </div>
      
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm truncate">{fileName}</p>
        <p className="text-xs text-muted-foreground truncate">{filePath}</p>
      </div>
      
      {onDownload && (
        <Button size="sm" variant="ghost" onClick={onDownload}>
          <Download className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
