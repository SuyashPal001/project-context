export type ZoomLevel = 'week' | 'month';

export interface TimelineDependency {
    id: string;
    fromTaskId: string;
    toTaskId: string;
    relationType: 'blocks' | 'blocked_by' | 'start_before' | 'finish_before';
}

export interface TimelinePlan {
    id: string;
    title: string;
    startDate: string | null;
    targetDate: string | null;
    status: string;
}

export interface TimelineMilestone {
    id: string;
    title: string;
    startDate: string | null;
    targetDate: string | null;
    completedAt: string | null;
    status: string;
    priority: string;
    assigneeId: string | null;
    taskCount: number;
    completedTaskCount: number;
}

export interface TimelineTask {
    id: string;
    title: string;
    milestoneId: string | null;
    parentTaskId: string | null;
    assigneeId: string | null;
    status: string;
    priority: string;
    startDate: string | null;
    dueDate: string | null;
    startedAt: string | null;
    completedAt: string | null;
    estimatedHours: string | null;
    totalSteps: number;
    completedSteps: number;
    dependencies: TimelineDependency[];
}

export interface TimelineBlock {
    id: string;
    type: 'milestone' | 'task' | 'subtask';
    title: string;
    assigneeId: string | null;
    status: string;
    priority: string;
    milestoneId: string | null;
    parentTaskId: string | null;
    marginLeft: number;
    width: number;
    isPoint: boolean;
    progressPercent: number;
    dependencies: TimelineDependency[];
    raw: TimelineTask | TimelineMilestone;
}

export interface TimelineRow {
    type: 'milestone' | 'task' | 'subtask';
    id: string;
    milestoneId: string | null;
    depth: 0 | 1 | 2;
}
