export type PlanStatus = 'draft' | 'active' | 'completed' | 'archived'
export type MilestoneStatus = 'backlog' | 'in_progress' | 'completed' | 'cancelled'
export type Priority = 'low' | 'medium' | 'high' | 'urgent'

export type Plan = {
    id: string
    sequenceId: number
    title: string
    description: string | null
    status: PlanStatus
    startDate: string | null
    targetDate: string | null
    createdAt: string
}

export type PlanSummary = {
    totalMilestones: number
    completedMilestones: number
    totalTasks: number
    completedTasks: number
}

export type Milestone = {
    id: string
    sequenceId: number
    title: string
    description: string | null
    status: MilestoneStatus
    targetDate: string | null
    assigneeId: string | null
    priority: Priority
    totalTasks: number
    completedTasks: number
    createdAt: string
}

export type AcItem = { text: string; checked?: boolean }

export type PlanTask = {
    id: string
    sequenceId: number | null
    title: string
    description: string | null
    status: string
    priority: Priority
    milestoneId: string | null
    assigneeId: string | null
    dueDate: string | null
    acceptanceCriteria?: AcItem[]
    estimatedHours?: string | null
}

export type Member = { userId: string; userName: string | null; userEmail: string; roleName: string }

export const PLAN_STATUS_CONFIG: Record<PlanStatus, { label: string; color: string; bg: string }> = {
    draft:     { label: 'Draft',     color: 'text-gray-400',    bg: 'bg-gray-500/10' },
    active:    { label: 'Active',    color: 'text-blue-400',    bg: 'bg-blue-500/10' },
    completed: { label: 'Completed', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
    archived:  { label: 'Archived',  color: 'text-gray-500',    bg: 'bg-gray-500/10' },
}

export const MILESTONE_STATUS_CONFIG: Record<MilestoneStatus, { label: string; color: string; bg: string }> = {
    backlog:     { label: 'Backlog',     color: 'text-gray-400',    bg: 'bg-gray-500/10' },
    in_progress: { label: 'In Progress', color: 'text-blue-400',    bg: 'bg-blue-500/10' },
    completed:   { label: 'Completed',   color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
    cancelled:   { label: 'Cancelled',   color: 'text-red-400',     bg: 'bg-red-500/10' },
}

export const VALID_MILESTONE_TRANSITIONS: Record<MilestoneStatus, MilestoneStatus[]> = {
    backlog:     ['in_progress', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    completed:   [],
    cancelled:   [],
}

export const PRIORITY_CONFIG: Record<Priority, { label: string; color: string }> = {
    low:    { label: 'Low',    color: '#6B7280' },
    medium: { label: 'Medium', color: '#3B82F6' },
    high:   { label: 'High',   color: '#F59E0B' },
    urgent: { label: 'Urgent', color: '#EF4444' },
}

export const TASK_STATUS_COLORS: Record<string, string> = {
    backlog:           '#6B7280',
    todo:              '#3B82F6',
    in_progress:       '#8B5CF6',
    awaiting_approval: '#F59E0B',
    review:            '#F59E0B',
    blocked:           '#EF4444',
    done:              '#10B981',
    cancelled:         '#6B7280',
}
