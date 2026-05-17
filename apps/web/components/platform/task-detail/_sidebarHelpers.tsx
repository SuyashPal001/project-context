import { cn } from '@/lib/utils'

export const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {})
}

export const truncateUrl = (url: string, max = 40): string => {
    try {
        const { hostname, pathname } = new URL(url)
        const clean = hostname.replace(/^www\./, '') + pathname
        return clean.length > max ? clean.slice(0, max) + '...' : clean
    } catch {
        return url.length > max ? url.slice(0, max) + '...' : url
    }
}

export function formatRelativeTime(dateString: string): string {
    const date = new Date(dateString)
    const diffMs = Date.now() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m`
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours}h`
    const diffDays = Math.floor(diffHours / 24)
    if (diffDays < 7) return `${diffDays}d`
    return date.toLocaleDateString('en-us', { month: 'short', day: 'numeric' })
}

export const STATUS_CONFIG = {
    backlog:           { label: 'Backlog',           color: '#6B7280', bg: 'bg-gray-500/10',    text: 'text-gray-400' },
    todo:              { label: 'Todo',              color: '#3B82F6', bg: 'bg-blue-500/10',    text: 'text-blue-400' },
    planning:          { label: 'Planning',          color: '#F59E0B', bg: 'bg-amber-500/10',   text: 'text-amber-400' },
    awaiting_approval: { label: 'Awaiting Approval', color: '#8B5CF6', bg: 'bg-purple-500/10',  text: 'text-purple-400' },
    in_progress:       { label: 'In Progress',       color: '#F59E0B', bg: 'bg-amber-500/10',   text: 'text-amber-400' },
    review:            { label: 'Review',            color: '#8B5CF6', bg: 'bg-purple-500/10',  text: 'text-purple-400' },
    blocked:           { label: 'Blocked',           color: '#EF4444', bg: 'bg-red-500/10',     text: 'text-red-400' },
    done:              { label: 'Done',              color: '#10B981', bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
    ready:             { label: 'Ready',             color: '#3B82F6', bg: 'bg-primary/10',     text: 'text-primary' },
    cancelled:         { label: 'Cancelled',         color: '#6B7280', bg: 'bg-gray-500/10',    text: 'text-gray-400' },
} as const

export const PRIORITY_CONFIG = {
    low:    { label: 'Low',    color: '#6B7280', text: 'text-gray-400' },
    medium: { label: 'Medium', color: '#3B82F6', text: 'text-blue-400' },
    high:   { label: 'High',   color: '#F59E0B', text: 'text-amber-400' },
    urgent: { label: 'Urgent', color: '#EF4444', text: 'text-red-400' },
} as const

export function StatusIcon({ status, className }: { status: string; className?: string }) {
    const configs = {
        backlog:    <circle cx="12" cy="12" r="9" stroke="#6B7280" strokeWidth="1.5" strokeDasharray="4 2" fill="none" />,
        todo:       <circle cx="12" cy="12" r="9" stroke="#3B82F6" strokeWidth="1.5" fill="none" />,
        ready:      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" fill="none" />,
        in_progress: <>
            <circle cx="12" cy="12" r="9" stroke="#F59E0B" strokeWidth="1.5" fill="none" />
            <circle cx="12" cy="12" r="4" fill="#F59E0B" />
        </>,
        review:    <circle cx="12" cy="12" r="9" stroke="#8B5CF6" strokeWidth="1.5" fill="none" />,
        blocked:   <circle cx="12" cy="12" r="9" stroke="#EF4444" strokeWidth="1.5" fill="none" />,
        done: <>
            <circle cx="12" cy="12" r="9" fill="#10B981" />
            <path d="M8 12l3 3 5-5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </>,
        cancelled: <circle cx="12" cy="12" r="9" stroke="#6B7280" strokeWidth="1.5" fill="none" />,
    }
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className={className}>
            {configs[status as keyof typeof configs] ?? configs.backlog}
        </svg>
    )
}

export function PriorityIcon({ priority, className }: { priority: string; className?: string }) {
    return (
        <div
            className={cn('w-2 h-2 rounded-full', className)}
            style={{ backgroundColor: PRIORITY_CONFIG[priority as keyof typeof PRIORITY_CONFIG]?.color }}
        />
    )
}
