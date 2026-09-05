import {
    Clock,
    CheckCircle2,
    HelpCircle,
    AlertTriangle,
    FileText,
    Map,
    ListChecks,
    Bell,
    type LucideIcon,
} from "lucide-react"

interface NotificationVisual {
    icon: LucideIcon
    bg: string
    fg: string
}

// messageType taxonomy from packages/foundation/database/notification-workflows.ts
// (MESSAGE_TYPES). Keyed by the full type first, falling back to the
// dot-prefix (e.g. "task.*") so a new task.* variant still gets a sane icon
// without a code change, and anything wholly unrecognized gets a plain bell.
const VISUALS: Record<string, NotificationVisual> = {
    "task.awaiting_approval": { icon: Clock, bg: "bg-amber-500/15", fg: "text-amber-500" },
    "task.completed": { icon: CheckCircle2, bg: "bg-emerald-500/15", fg: "text-emerald-500" },
    "task.needs_clarification": { icon: HelpCircle, bg: "bg-blue-500/15", fg: "text-blue-500" },
    "task.failed": { icon: AlertTriangle, bg: "bg-red-500/15", fg: "text-red-500" },
    "task": { icon: Clock, bg: "bg-amber-500/15", fg: "text-amber-500" },
    "prd.created": { icon: FileText, bg: "bg-purple-500/15", fg: "text-purple-500" },
    "prd": { icon: FileText, bg: "bg-purple-500/15", fg: "text-purple-500" },
    "roadmap.created": { icon: Map, bg: "bg-indigo-500/15", fg: "text-indigo-500" },
    "roadmap": { icon: Map, bg: "bg-indigo-500/15", fg: "text-indigo-500" },
    "tasks.created": { icon: ListChecks, bg: "bg-teal-500/15", fg: "text-teal-500" },
    "tasks": { icon: ListChecks, bg: "bg-teal-500/15", fg: "text-teal-500" },
}

const DEFAULT_VISUAL: NotificationVisual = { icon: Bell, bg: "bg-muted", fg: "text-muted-foreground" }

export function getNotificationVisual(messageType: string): NotificationVisual {
    if (VISUALS[messageType]) return VISUALS[messageType]
    const prefix = messageType.split(".")[0]
    if (VISUALS[prefix]) return VISUALS[prefix]
    return DEFAULT_VISUAL
}

export function NotificationIcon({ messageType, className }: { messageType: string; className?: string }) {
    const { icon: Icon, bg, fg } = getNotificationVisual(messageType)
    return (
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${bg} ${className ?? ""}`}>
            <Icon className={`h-4 w-4 ${fg}`} />
        </span>
    )
}
