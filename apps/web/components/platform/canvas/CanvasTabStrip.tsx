'use client';

import { Plus, X, FileText, Film, LayoutGrid } from 'lucide-react';
import type { CanvasTab } from './types';

const TAB_ICONS: Record<CanvasTab['kind'], React.ElementType> = {
  artifact: FileText,
  file: Film,
  gallery: LayoutGrid,
};

interface CanvasTabStripProps {
  tabs: CanvasTab[];
  activeTabId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onOpenGallery: () => void;
}

export function CanvasTabStrip({ tabs, activeTabId, onSelect, onClose, onOpenGallery }: CanvasTabStripProps) {
  return (
    <div className="flex-none flex items-center gap-1.5 px-2 py-2 border-b border-border overflow-x-auto">
      <button
        onClick={onOpenGallery}
        title="Open Chat History"
        className="flex-none h-8 w-8 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        <Plus className="h-4 w-4" />
      </button>
      {tabs.map(tab => {
        const Icon = TAB_ICONS[tab.kind];
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={`group flex-none flex items-center gap-1.5 h-8 pl-3 pr-2 rounded-full text-xs font-medium whitespace-nowrap cursor-pointer transition-colors ${
              isActive ? 'bg-secondary text-foreground border border-border' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
            onClick={() => onSelect(tab.id)}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate max-w-[120px]">{tab.title}</span>
            {tab.kind === 'artifact' && tab.artifact?.isStreaming && (
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse shrink-0" />
            )}
            {tab.closeable && (
              <button
                onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
                className="opacity-0 group-hover:opacity-100 h-4 w-4 flex items-center justify-center rounded-full hover:bg-muted shrink-0"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
