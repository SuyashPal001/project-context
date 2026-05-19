import {
    parseISO, startOfMonth, startOfWeek,
    addDays, addMonths, subDays,
    differenceInDays, format,
    isBefore, isAfter,
} from 'date-fns';
import type { ZoomLevel, TimelinePlan, TimelineMilestone, TimelineTask, TimelineBlock } from './types';

export function getChartBoundaries(
    plan: Pick<TimelinePlan, 'startDate' | 'targetDate'>,
    milestones: Pick<TimelineMilestone, 'startDate' | 'targetDate'>[],
    tasks: Pick<TimelineTask, 'startDate' | 'dueDate'>[],
): { chartStart: Date; chartEnd: Date } {
    const raw: (string | null | undefined)[] = [
        plan.startDate, plan.targetDate,
        ...milestones.flatMap(m => [m.startDate, m.targetDate]),
        ...tasks.flatMap(t => [t.startDate, t.dueDate]),
    ];
    const dates = raw.filter((d): d is string => !!d).map(d => parseISO(d));

    if (dates.length === 0) {
        const today = new Date();
        return { chartStart: startOfMonth(today), chartEnd: addMonths(today, 3) };
    }

    const times = dates.map(d => d.getTime());
    return {
        chartStart: subDays(new Date(Math.min(...times)), 7),
        chartEnd: addDays(new Date(Math.max(...times)), 14),
    };
}

export function getDayWidth(zoom: ZoomLevel): number {
    return zoom === 'week' ? 40 : 18;
}

export function getItemPositionWidth(
    startDate: Date | null,
    endDate: Date | null,
    chartStart: Date,
    dayWidth: number,
): { marginLeft: number; width: number; isPoint: boolean } {
    if (!startDate && !endDate) return { marginLeft: 0, width: 0, isPoint: true };

    if (!startDate && endDate) {
        return {
            marginLeft: differenceInDays(endDate, chartStart) * dayWidth,
            width: dayWidth,
            isPoint: true,
        };
    }

    if (startDate && !endDate) {
        return {
            marginLeft: differenceInDays(startDate, chartStart) * dayWidth,
            width: dayWidth,
            isPoint: true,
        };
    }

    return {
        marginLeft: differenceInDays(startDate!, chartStart) * dayWidth,
        width: Math.max(differenceInDays(endDate!, startDate!) * dayWidth, dayWidth),
        isPoint: false,
    };
}

export function getProgressPercent(completed: number, total: number): number {
    if (total === 0) return 0;
    return Math.min(100, Math.round((completed / total) * 100));
}

export function buildBlocksMap(
    milestones: TimelineMilestone[],
    tasks: TimelineTask[],
    chartStart: Date,
    dayWidth: number,
): Map<string, TimelineBlock> {
    const map = new Map<string, TimelineBlock>();

    for (const m of milestones) {
        const pos = getItemPositionWidth(
            m.startDate ? parseISO(m.startDate) : null,
            m.targetDate ? parseISO(m.targetDate) : null,
            chartStart, dayWidth,
        );
        map.set(m.id, {
            id: m.id, type: 'milestone', title: m.title,
            assigneeId: m.assigneeId, status: m.status, priority: m.priority,
            milestoneId: m.id, parentTaskId: null,
            ...pos,
            progressPercent: getProgressPercent(m.completedTaskCount, m.taskCount),
            dependencies: [],
            raw: m,
        });
    }

    for (const t of tasks) {
        const pos = getItemPositionWidth(
            t.startDate ? parseISO(t.startDate) : null,
            t.dueDate ? parseISO(t.dueDate) : null,
            chartStart, dayWidth,
        );
        map.set(t.id, {
            id: t.id, type: t.parentTaskId ? 'subtask' : 'task', title: t.title,
            assigneeId: t.assigneeId, status: t.status, priority: t.priority,
            milestoneId: t.milestoneId, parentTaskId: t.parentTaskId,
            ...pos,
            progressPercent: getProgressPercent(t.completedSteps, t.totalSteps),
            dependencies: t.dependencies,
            raw: t,
        });
    }

    return map;
}

export function getTimelineScale(
    chartStart: Date,
    chartEnd: Date,
    zoom: ZoomLevel,
    dayWidth: number,
): { months: { label: string; days: number }[]; markers: { date: Date; label: string; marginLeft: number }[] } {
    // Month header segments
    const months: { label: string; days: number }[] = [];
    let cursor = startOfMonth(chartStart);
    while (!isAfter(cursor, chartEnd)) {
        const next = addMonths(cursor, 1);
        const segStart = isBefore(cursor, chartStart) ? chartStart : cursor;
        const segEnd = isAfter(next, chartEnd) ? addDays(chartEnd, 1) : next; // exclusive
        months.push({ label: format(cursor, 'MMM yyyy'), days: differenceInDays(segEnd, segStart) });
        cursor = next;
    }

    // Tick markers
    const markers: { date: Date; label: string; marginLeft: number }[] = [];
    if (zoom === 'week') {
        let d = startOfWeek(chartStart, { weekStartsOn: 1 });
        if (isBefore(d, chartStart)) d = addDays(d, 7);
        while (!isAfter(d, chartEnd)) {
            markers.push({ date: d, label: format(d, 'MMM d'), marginLeft: differenceInDays(d, chartStart) * dayWidth });
            d = addDays(d, 7);
        }
    } else {
        let d = addMonths(startOfMonth(chartStart), 1);
        while (!isAfter(d, chartEnd)) {
            markers.push({ date: d, label: format(d, 'MMM yyyy'), marginLeft: differenceInDays(d, chartStart) * dayWidth });
            d = addMonths(d, 1);
        }
    }

    return { months, markers };
}
