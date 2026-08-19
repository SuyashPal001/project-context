'use client';

import { cn } from '@/lib/utils';
import {
  MousePointer2,
  Type,
  Navigation,
  ScrollText,
  FileText,
  Camera,
  Clock,
} from 'lucide-react';
import type { CanvasEvent, CanvasAction } from './types';

interface ActionTimelineProps {
  events: CanvasEvent[];
  maxItems?: number;
}

const actionIcons: Record<CanvasAction, React.ElementType> = {
  screenshot: Camera,
  click: MousePointer2,
  type: Type,
  navigate: Navigation,
  scroll: ScrollText,
  file_created: FileText,
  artifact_start: FileText,
  artifact_chunk: FileText,
  artifact_done: FileText,
  artifact_load: FileText,
  asset_open: FileText,
};

const actionLabels: Record<CanvasAction, string> = {
  screenshot: 'Screenshot',
  click: 'Clicked',
  type: 'Typed',
  navigate: 'Navigated to',
  scroll: 'Scrolled',
  file_created: 'Created file',
  artifact_start: 'Artifact started',
  artifact_chunk: 'Artifact chunk',
  artifact_done: 'Artifact saved',
  artifact_load: 'Artifact loaded',
  asset_open: 'Asset opened',
};

export function ActionTimeline({ events, maxItems = 10 }: ActionTimelineProps) {
  const displayEvents = events.slice(-maxItems).reverse();

  if (displayEvents.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-4">
        <Clock className="h-6 w-6 mx-auto mb-2 opacity-50" />
        <p className="text-sm">No actions yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {displayEvents.map((event, index) => {
        const Icon = actionIcons[event.action];
        const label = actionLabels[event.action];
        const detail = getEventDetail(event);
        const time = new Date(event.timestamp).toLocaleTimeString();

        return (
          <div
            key={event.id}
            className={cn(
              'flex items-start gap-3 p-2 rounded-lg transition-colors',
              index === 0 ? 'bg-primary/10' : 'hover:bg-muted/50'
            )}
          >
            <div className={cn(
              'p-1.5 rounded',
              index === 0 ? 'bg-primary text-primary-foreground' : 'bg-muted'
            )}>
              <Icon className="h-3.5 w-3.5" />
            </div>
            
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{label}</p>
              {detail && (
                <p className="text-xs text-muted-foreground truncate">
                  {detail}
                </p>
              )}
            </div>
            
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {time}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function getEventDetail(event: CanvasEvent): string | null {
  switch (event.action) {
    case 'click':
      return event.data.elementSelector ?? null;
    case 'type':
      return event.data.text ?? null;
    case 'navigate':
      return event.data.url ?? null;
    case 'file_created':
      return event.data.filePath ?? null;
    case 'scroll':
      return event.data.scrollTop ? `Position: ${event.data.scrollTop}px` : null;
    default:
      return null;
  }
}
