'use client';
import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { differenceInDays } from 'date-fns';
import { api } from '@/lib/api';
import { pmKeys } from '@/lib/query-keys/pm';
import { getChartBoundaries, getDayWidth, buildBlocksMap } from './helpers';
import type { ZoomLevel, TimelinePlan, TimelineMilestone, TimelineTask, TimelineBlock, TimelineRow } from './types';

// Stable empty references — prevent useMemo re-runs during loading
const EMPTY_MILESTONES: TimelineMilestone[] = [];
const EMPTY_TASKS: TimelineTask[] = [];

interface TimelineApiResponse {
    data: { plan: TimelinePlan; milestones: TimelineMilestone[]; tasks: TimelineTask[] };
}

export interface TimelineStore {
    plan: TimelinePlan | null;
    milestones: TimelineMilestone[];
    tasks: TimelineTask[];
    isLoading: boolean;
    error: Error | null;
    zoom: ZoomLevel;
    setZoom: (z: ZoomLevel) => void;
    chartStart: Date;
    chartEnd: Date;
    dayWidth: number;
    totalWidth: number;
    blocksMap: Map<string, TimelineBlock>;
    collapsedMilestones: Set<string>;
    toggleMilestone: (id: string) => void;
    rows: TimelineRow[];
    unscheduledTasks: TimelineTask[];
}

export function useTimelineStore(planId: string): TimelineStore {
    const [zoom, setZoom] = useState<ZoomLevel>('month');
    const [collapsedMilestones, setCollapsedMilestones] = useState<Set<string>>(new Set());

    // Single query — no waterfall, no N+1
    const { data, isLoading, error } = useQuery({
        queryKey: pmKeys.planTimeline(planId),
        queryFn: () => api.get<TimelineApiResponse>(`/api/v1/plans/${planId}/timeline`),
        enabled: !!planId,
    });

    const plan = data?.data?.plan ?? null;
    const milestones = data?.data?.milestones ?? EMPTY_MILESTONES;
    const tasks = data?.data?.tasks ?? EMPTY_TASKS;

    // Recalculates when server data changes
    const { chartStart, chartEnd } = useMemo(
        () => getChartBoundaries(plan ?? { startDate: null, targetDate: null }, milestones, tasks),
        [plan, milestones, tasks],
    );

    const dayWidth = getDayWidth(zoom);
    const totalWidth = differenceInDays(chartEnd, chartStart) * dayWidth;

    // Recalculates when data OR zoom changes (dayWidth encodes zoom)
    const blocksMap = useMemo(
        () => buildBlocksMap(milestones, tasks, chartStart, dayWidth),
        [milestones, tasks, chartStart, dayWidth],
    );

    // Flat ordered row list — respects collapsedMilestones
    const rows = useMemo<TimelineRow[]>(() => {
        // Build lookup maps in O(n) to avoid nested filter loops
        const byMilestone = new Map<string, TimelineTask[]>();
        const byParent = new Map<string, TimelineTask[]>();
        for (const t of tasks) {
            if (t.milestoneId && !t.parentTaskId) {
                if (!byMilestone.has(t.milestoneId)) byMilestone.set(t.milestoneId, []);
                byMilestone.get(t.milestoneId)!.push(t);
            }
            if (t.parentTaskId) {
                if (!byParent.has(t.parentTaskId)) byParent.set(t.parentTaskId, []);
                byParent.get(t.parentTaskId)!.push(t);
            }
        }

        const result: TimelineRow[] = [];

        for (const m of milestones) {
            result.push({ type: 'milestone', id: m.id, milestoneId: m.id, depth: 0 });
            if (collapsedMilestones.has(m.id)) continue;
            for (const t of byMilestone.get(m.id) ?? []) {
                result.push({ type: 'task', id: t.id, milestoneId: m.id, depth: 1 });
                for (const s of byParent.get(t.id) ?? []) {
                    result.push({ type: 'subtask', id: s.id, milestoneId: m.id, depth: 2 });
                }
            }
        }

        // Floating tasks: no milestone, no parent
        for (const t of tasks) {
            if (!t.milestoneId && !t.parentTaskId) {
                result.push({ type: 'task', id: t.id, milestoneId: null, depth: 0 });
            }
        }

        return result;
    }, [milestones, tasks, collapsedMilestones]);

    const unscheduledTasks = useMemo(
        () => tasks.filter(t => !t.startDate && !t.dueDate),
        [tasks],
    );

    const toggleMilestone = (id: string) => {
        setCollapsedMilestones(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    return {
        plan, milestones, tasks,
        isLoading, error: error as Error | null,
        zoom, setZoom,
        chartStart, chartEnd, dayWidth, totalWidth,
        blocksMap,
        collapsedMilestones, toggleMilestone,
        rows, unscheduledTasks,
    };
}
