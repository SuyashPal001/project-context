'use client';

import { FileText, Map, CheckSquare, ChevronRight } from 'lucide-react';
import type { ArtifactRef } from '../chat/types';

const TYPE_ICONS = {
  prd:     <FileText className="h-4 w-4 text-primary" />,
  roadmap: <Map className="h-4 w-4 text-blue-400" />,
  tasks:   <CheckSquare className="h-4 w-4 text-green-400" />,
};

const TYPE_LABELS = {
  prd:     'PRD',
  roadmap: 'Roadmap',
  tasks:   'Task List',
};

export function ChatArtifactCard({ type, entityId, title, content, pmRunId, pmStepId }: ArtifactRef) {
  const handleClick = () => {
    (window as any).__openCanvas?.();
    (window as any).__canvasUpdate?.('artifact_load', {
      artifactType: type,
      artifactTitle: title,
      entityId,
      chunk: content,
      // Pass HITL data so Canvas can show the correct approval button
      entityMeta: pmRunId ? { pmRunId, pmStepId } : undefined,
    });
  };

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-border/60 bg-muted/30 hover:bg-muted/60 transition-colors text-left w-full max-w-xs group mt-2"
    >
      <div className="h-8 w-8 rounded-lg bg-background border border-border/40 flex items-center justify-center shrink-0">
        {TYPE_ICONS[type]}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">{TYPE_LABELS[type]}</p>
        <p className="text-sm font-medium text-foreground truncate leading-tight">{title}</p>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
    </button>
  );
}
