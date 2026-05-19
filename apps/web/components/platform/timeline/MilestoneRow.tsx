'use client';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { format, parseISO } from 'date-fns';
import type { TimelineMilestone, TimelineBlock } from './types';
import { ROW_HEIGHT } from './TaskBar';

const BAR_H = 32;

const STATUS_BG: Record<string, string> = {
    backlog:     'bg-slate-600',
    todo:        'bg-slate-500',
    in_progress: 'bg-blue-500',
    review:      'bg-violet-400',
    blocked:     'bg-red-400',
    done:        'bg-emerald-500',
    cancelled:   'bg-slate-400',
};
const STATUS_FILL: Record<string, string> = {
    in_progress: 'bg-blue-600',
    review:      'bg-violet-500',
    blocked:     'bg-red-500',
    done:        'bg-emerald-600',
    todo:        'bg-slate-600',
};
const BADGE_CLS: Record<string, string> = {
    todo:        'bg-slate-700/60 text-slate-300 border-slate-600',
    in_progress: 'bg-blue-950 text-blue-300 border-blue-800',
    done:        'bg-emerald-950 text-emerald-300 border-emerald-800',
    blocked:     'bg-red-950 text-red-300 border-red-800',
    review:      'bg-violet-950 text-violet-300 border-violet-800',
    cancelled:   'bg-zinc-800 text-zinc-400 border-zinc-700',
    backlog:     'bg-zinc-800 text-zinc-400 border-zinc-700',
};

function fmtDate(d: string | null) {
    if (!d) return null;
    try { return format(parseISO(d), 'MMM d, yyyy'); } catch { return null; }
}

// ─── Chart bar (placed in chart column) ──────────────────────────────────────

interface MilestoneRowProps {
    milestone: TimelineMilestone;
    block: TimelineBlock;
    rowHeight?: number;
}

export function MilestoneRow({ milestone, block, rowHeight = ROW_HEIGHT }: MilestoneRowProps) {
    const pct = milestone.taskCount > 0
        ? (milestone.completedTaskCount / milestone.taskCount) * 100 : 0;
    const bg   = STATUS_BG[milestone.status] ?? 'bg-slate-500';
    const fill = STATUS_FILL[milestone.status];
    const topOffset = (rowHeight - BAR_H) / 2;
    const target = fmtDate(milestone.targetDate);

    if (block.isPoint) {
        return (
            <div
                className="absolute top-0 w-0.5 bg-violet-400/80"
                style={{ left: block.marginLeft, height: rowHeight }}
            />
        );
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <div
                    className={`absolute rounded-lg overflow-hidden cursor-pointer ${bg}`}
                    style={{ left: block.marginLeft, top: topOffset, width: block.width, height: BAR_H }}
                >
                    {fill && pct > 0 && (
                        <div className={`absolute inset-y-0 left-0 ${fill} opacity-60`} style={{ width: `${pct}%` }} />
                    )}
                    {block.width >= 48 && (
                        <span className="relative z-10 px-2 text-xs font-semibold text-white leading-8 truncate block">
                            {milestone.title}
                        </span>
                    )}
                </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-left">
                <div className="space-y-0.5 text-xs">
                    <p className="font-medium">{milestone.title}</p>
                    {target && <p className="text-muted-foreground">Target: {target}</p>}
                    <p className="text-muted-foreground capitalize">{milestone.status.replace(/_/g, ' ')}</p>
                    <p className="text-muted-foreground">{milestone.completedTaskCount}/{milestone.taskCount} done</p>
                </div>
            </TooltipContent>
        </Tooltip>
    );
}

// ─── Sidebar label (placed in sidebar column) ─────────────────────────────────

interface SidebarLabelProps {
    milestone: TimelineMilestone;
    isCollapsed: boolean;
    onToggle: () => void;
}

export function MilestoneSidebarLabel({ milestone, isCollapsed, onToggle }: SidebarLabelProps) {
    const badgeCls = BADGE_CLS[milestone.status] ?? 'bg-zinc-800 text-zinc-400 border-zinc-700';
    return (
        <div className="flex items-center gap-1 px-1.5 h-full min-w-0">
            <button
                onClick={onToggle}
                className="flex-shrink-0 h-5 w-5 flex items-center justify-center rounded hover:bg-accent text-muted-foreground"
                aria-label={isCollapsed ? 'Expand milestone' : 'Collapse milestone'}
            >
                {isCollapsed
                    ? <ChevronRight className="h-3.5 w-3.5" />
                    : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            <span className="flex-1 text-xs font-semibold text-foreground truncate">{milestone.title}</span>
            <span className="text-[10px] text-muted-foreground flex-shrink-0 pr-0.5">
                {milestone.completedTaskCount}/{milestone.taskCount}
            </span>
            <Badge
                variant="outline"
                className={`text-[9px] px-1 py-0 h-4 flex-shrink-0 capitalize border ${badgeCls}`}
            >
                {milestone.status.replace(/_/g, ' ')}
            </Badge>
        </div>
    );
}
