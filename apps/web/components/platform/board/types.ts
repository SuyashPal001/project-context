// ─── Types ────────────────────────────────────────────────────────────────────

export type Task = {
    id: string
    sequenceId: number | null
    agentId: string | null
    assigneeId: string | null
    createdBy?: string | null
    milestoneId: string | null
    planId: string | null
    parentTaskId: string | null
    title: string
    description?: string | null
    status: 'backlog' | 'todo' | 'in_progress' | 'awaiting_approval' | 'review' | 'blocked' | 'done' | 'cancelled'
    priority: 'low' | 'medium' | 'high' | 'urgent'
    estimatedHours?: string | number | null
    confidenceScore?: string | number | null
    totalSteps: number
    completedSteps: number
    createdAt: string
    planApprovedAt?: string | null
    blockedReason?: string | null
    dueDate?: string | null
    upvotes: number
    downvotes: number
    links: string[]
    sortOrder: number
}

export type TasksResponse = { data: Task[] }
export type AgentsResponse = { data: { id: string; name: string; status: string }[] }
export type MembersResponse = { members: { userId: string; userName: string | null; userEmail: string; roleName: string; status: 'active' | 'invited' | 'suspended' }[] }
export type Assignee = { type: 'agent'; id: string; name: string } | { type: 'member'; id: string; name: string }

// ─── Constants ────────────────────────────────────────────────────────────────

export const STATUS_CONFIG = {
    backlog:          { label: 'Backlog',           color: '#6B7280', bg: 'bg-gray-500/10',    text: 'text-gray-400' },
    todo:             { label: 'Todo',              color: '#3B82F6', bg: 'bg-blue-500/10',    text: 'text-blue-400' },
    in_progress:      { label: 'In Progress',       color: '#8B5CF6', bg: 'bg-purple-500/10',  text: 'text-purple-400' },
    awaiting_approval:{ label: 'Awaiting Approval', color: '#F59E0B', bg: 'bg-amber-500/10',   text: 'text-amber-400' },
    review:           { label: 'Review',            color: '#F59E0B', bg: 'bg-amber-500/10',   text: 'text-amber-400' },
    blocked:          { label: 'Blocked',           color: '#EF4444', bg: 'bg-red-500/10',     text: 'text-red-400' },
    done:             { label: 'Done',              color: '#10B981', bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
    cancelled:        { label: 'Cancelled',         color: '#6B7280', bg: 'bg-gray-500/10',    text: 'text-gray-400' },
} as const

export const PRIORITY_CONFIG = {
    low:    { label: 'Low',    color: '#6B7280', text: 'text-gray-400' },
    medium: { label: 'Medium', color: '#3B82F6', text: 'text-blue-400' },
    high:   { label: 'High',   color: '#F59E0B', text: 'text-amber-400' },
    urgent: { label: 'Urgent', color: '#EF4444', text: 'text-red-400' },
} as const

export const COLUMNS: Task['status'][] = ['backlog', 'todo', 'in_progress', 'awaiting_approval', 'review', 'done', 'blocked']

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const normalizeUrl = (url: string): string => {
    const trimmed = url.trim()
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

export function formatRelativeTime(dateString: string): string {
    const date = new Date(dateString)
    const diffMs = Date.now() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours}h ago`
    const diffDays = Math.floor(diffHours / 24)
    if (diffDays < 30) return `${diffDays}d ago`
    return date.toLocaleDateString()
}
