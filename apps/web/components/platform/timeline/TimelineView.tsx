'use client';
import { useRef, useMemo, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { differenceInDays } from 'date-fns';
import { CalendarDays, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { TooltipProvider } from '@/components/ui/tooltip';
import { EmptyState } from '../shared/EmptyState';
import { useTimelineStore } from './useTimelineStore';
import { getTimelineScale } from './helpers';
import { pmKeys } from '@/lib/query-keys/pm';
import { TimelineHeader } from './TimelineHeader';
import { TimelineGrid } from './TimelineGrid';
import { TaskBar, ROW_HEIGHT } from './TaskBar';
import { MilestoneRow, MilestoneSidebarLabel } from './MilestoneRow';
import { RenderIfVisible } from './RenderIfVisible';
import { DependencyLines } from './DependencyLines';

export function TimelineView({ planId }: { planId: string }) {
    const queryClient = useQueryClient();
    const headerRef = useRef<HTMLDivElement>(null);
    const bodyRef   = useRef<HTMLDivElement>(null);

    const {
        milestones, tasks, isLoading, error,
        zoom, setZoom,
        chartStart, chartEnd, dayWidth, totalWidth,
        blocksMap, collapsedMilestones, toggleMilestone,
        rows, unscheduledTasks,
    } = useTimelineStore(planId);

    const scale = useMemo(
        () => getTimelineScale(chartStart, chartEnd, zoom, dayWidth),
        [chartStart, chartEnd, zoom, dayWidth],
    );
    const milestoneMap = useMemo(() => new Map(milestones.map(m => [m.id, m])), [milestones]);
    const taskMap      = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks]);

    const syncHeader = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        if (headerRef.current) headerRef.current.scrollLeft = e.currentTarget.scrollLeft;
    }, []);

    const scrollToToday = useCallback(() => {
        if (!bodyRef.current) return;
        const x = differenceInDays(new Date(), chartStart) * dayWidth;
        bodyRef.current.scrollLeft = Math.max(0, x - bodyRef.current.clientWidth / 2);
        if (headerRef.current) headerRef.current.scrollLeft = bodyRef.current.scrollLeft;
    }, [chartStart, dayWidth]);

    const retry = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: pmKeys.planTimeline(planId) });
    }, [queryClient, planId]);

    if (isLoading) return <LoadingSkeleton />;

    if (error) return (
        <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
            <AlertCircle className="h-10 w-10 text-destructive/70" />
            <p className="text-sm text-muted-foreground">{(error as Error).message ?? 'Failed to load timeline'}</p>
            <Button variant="outline" size="sm" onClick={retry}>Retry</Button>
        </div>
    );

    if (!milestones.length && !tasks.length) return (
        <EmptyState
            title="No timeline data"
            description="Add milestones and tasks with start or due dates to see them here."
        />
    );

    const totalH = rows.length * ROW_HEIGHT;

    return (
        <TooltipProvider delayDuration={200}>
            <div className="flex flex-col h-full border border-border rounded-lg overflow-hidden bg-background">

                {/* Controls */}
                <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2 border-b border-border">
                    <div className="flex border border-border rounded overflow-hidden text-xs">
                        <button
                            onClick={() => setZoom('week')}
                            className={`px-3 py-1.5 transition-colors ${zoom === 'week' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                        >Week</button>
                        <button
                            onClick={() => setZoom('month')}
                            className={`px-3 py-1.5 border-l border-border transition-colors ${zoom === 'month' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                        >Month</button>
                    </div>
                    <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={scrollToToday}>
                        <CalendarDays className="h-3.5 w-3.5" />Today
                    </Button>
                </div>

                {/* Vertical scroll container */}
                <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">

                    {/* Sticky header row */}
                    <div className="flex flex-shrink-0 sticky top-0 z-20 bg-background border-b border-border" style={{ height: 56 }}>
                        <div style={{ width: 240 }} className="flex-shrink-0 border-r border-border px-3 flex items-center">
                            <span className="text-xs font-medium text-muted-foreground">Task / Milestone</span>
                        </div>
                        {/* Overflow-hidden div synced to chart scroll */}
                        <div className="flex-1 overflow-hidden" ref={headerRef}>
                            <TimelineHeader scale={scale} dayWidth={dayWidth} chartStart={chartStart} totalWidth={totalWidth} />
                        </div>
                    </div>

                    {/* Row area */}
                    <div className="flex flex-1">

                        {/* Sidebar labels */}
                        <div style={{ width: 240 }} className="flex-shrink-0 border-r border-border">
                            {rows.map(row => {
                                if (row.type === 'milestone') {
                                    const m = milestoneMap.get(row.id)!;
                                    return (
                                        <div key={row.id} style={{ height: ROW_HEIGHT }} className="border-b border-border/20">
                                            <MilestoneSidebarLabel
                                                milestone={m}
                                                isCollapsed={collapsedMilestones.has(row.id)}
                                                onToggle={() => toggleMilestone(row.id)}
                                            />
                                        </div>
                                    );
                                }
                                const task = taskMap.get(row.id);
                                const pl = 8 + row.depth * 16;
                                return (
                                    <div
                                        key={row.id}
                                        style={{ height: ROW_HEIGHT, paddingLeft: pl }}
                                        className="border-b border-border/20 flex items-center pr-2"
                                    >
                                        <span className="text-xs text-muted-foreground truncate">{task?.title ?? '—'}</span>
                                    </div>
                                );
                            })}

                            {/* Unscheduled section */}
                            {unscheduledTasks.length > 0 && (
                                <>
                                    <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground bg-muted/30">
                                        Unscheduled ({unscheduledTasks.length})
                                    </div>
                                    {unscheduledTasks.map(t => (
                                        <div key={t.id} style={{ height: ROW_HEIGHT }} className="border-b border-border/20 flex items-center px-3">
                                            <span className="text-xs text-muted-foreground/60 truncate">{t.title}</span>
                                        </div>
                                    ))}
                                </>
                            )}
                        </div>

                        {/* Chart body — horizontal scroll */}
                        <div className="flex-1 overflow-x-auto" ref={bodyRef} onScroll={syncHeader}>
                            <div style={{ width: totalWidth }} className="relative">
                                <TimelineGrid
                                    scale={scale}
                                    dayWidth={dayWidth}
                                    chartStart={chartStart}
                                    totalWidth={totalWidth}
                                    height={totalH}
                                />
                                {rows.map(row => {
                                    const block = blocksMap.get(row.id);
                                    return (
                                        <RenderIfVisible key={row.id} height={ROW_HEIGHT}>
                                            <div className="relative border-b border-border/10" style={{ height: ROW_HEIGHT }}>
                                                {block && row.type === 'milestone' && (
                                                    <MilestoneRow
                                                        milestone={milestoneMap.get(row.id)!}
                                                        block={block}
                                                        rowHeight={ROW_HEIGHT}
                                                    />
                                                )}
                                                {block && row.type !== 'milestone' && (
                                                    <TaskBar block={block} rowHeight={ROW_HEIGHT} />
                                                )}
                                            </div>
                                        </RenderIfVisible>
                                    );
                                })}
                                <DependencyLines
                                    blocksMap={blocksMap}
                                    rows={rows}
                                    totalWidth={totalWidth}
                                    totalHeight={totalH}
                                />
                            </div>
                        </div>

                    </div>
                </div>
            </div>
        </TooltipProvider>
    );
}

function LoadingSkeleton() {
    const rows = [
        { w: 192, ml: 0 }, { w: 128, ml: 20 }, { w: 128, ml: 20 }, { w: 128, ml: 20 },
        { w: 192, ml: 0 }, { w: 128, ml: 20 }, { w: 128, ml: 20 }, { w: 144, ml: 36 },
    ];
    return (
        <div className="flex flex-col gap-3 p-6">
            {rows.map((r, i) => (
                <Skeleton key={i} className="h-4 rounded" style={{ width: r.w, marginLeft: r.ml }} />
            ))}
        </div>
    );
}
