'use client';

import { Plus, X, FileText, BookOpen, Film, LayoutGrid } from 'lucide-react';
import type { CanvasTab } from './types';

const TAB_ICONS: Record<CanvasTab['kind'], React.ElementType> = {
  artifact: FileText,
  knowledge: BookOpen,
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
    <div className="flex-none flex items-stretch border-b border-border overflow-x-auto">
      <button
        onClick={onOpenGallery}
        title="Open Chat History"
        className="flex-none w-9 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/50 border-r border-border"
      >
        <Plus className="h-4 w-4" />
      </button>
      {tabs.map(tab => {
        const Icon = TAB_ICONS[tab.kind];
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={`group flex-none flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap cursor-pointer transition-colors ${
              isActive ? 'text-foreground border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground'
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
                className="opacity-0 group-hover:opacity-100 h-4 w-4 flex items-center justify-center rounded hover:bg-muted shrink-0"
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
