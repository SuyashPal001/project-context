'use client';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { TimelineBlock } from './types';

export const ROW_HEIGHT = 40;

const STATUS_COLOR: Record<string, string> = {
    backlog:     'bg-slate-600',
    todo:        'bg-slate-500',
    in_progress: 'bg-blue-500',
    review:      'bg-violet-400',
    blocked:     'bg-red-400',
    done:        'bg-emerald-500',
    cancelled:   'bg-slate-400',
    completed:   'bg-emerald-500',
    pending:     'bg-slate-400',
};

const PRIORITY_BORDER: Record<string, string> = {
    urgent: 'border-l-[3px] border-red-500',
    high:   'border-l-[3px] border-orange-500',
    medium: 'border-l-[3px] border-yellow-400',
    low:    '',
};

interface Props {
    block: TimelineBlock;
    rowHeight: number;
}

export function TaskBar({ block, rowHeight }: Props) {
    const barH = block.type === 'subtask' ? 20 : 28;
    const topOffset = (rowHeight - barH) / 2;
    const color = STATUS_COLOR[block.status] ?? 'bg-slate-400';
    const border = PRIORITY_BORDER[block.priority] ?? '';
    const showTitle = block.width >= 60;

    if (block.isPoint) {
        const size = 12;
        return (
            <Tooltip>
                <TooltipTrigger asChild>
                    <div
                        className="absolute cursor-pointer"
                        style={{ left: block.marginLeft - size / 2, top: (rowHeight - size) / 2, width: size, height: size }}
                    >
                        <div className={cn('w-full h-full rotate-45 opacity-80 hover:opacity-100 transition-opacity', color)} />
                    </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs max-w-48">
                    <p className="font-medium">{block.title}</p>
                    <p className="text-muted-foreground capitalize">{block.status.replace(/_/g, ' ')}</p>
                </TooltipContent>
            </Tooltip>
        );
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <div
                    className={cn(
                        'absolute rounded overflow-hidden cursor-pointer opacity-85 hover:opacity-100 transition-opacity',
                        color, border,
                    )}
                    style={{ left: block.marginLeft, width: block.width, top: topOffset, height: barH }}
                >
                    {block.progressPercent > 0 && (
                        <div
                            className="absolute left-0 top-0 bottom-0 bg-black/25 transition-[width]"
                            style={{ width: `${block.progressPercent}%` }}
                        />
                    )}
                    {showTitle && (
                        <span className="relative px-1.5 text-[10px] text-white font-medium flex items-center h-full truncate">
                            {block.title}
                        </span>
                    )}
                </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs max-w-48">
                <p className="font-medium">{block.title}</p>
                <p className="text-muted-foreground capitalize">
                    {block.status.replace(/_/g, ' ')} · {block.progressPercent}%
                </p>
            </TooltipContent>
        </Tooltip>
    );
}
