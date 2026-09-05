"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Bell, CheckCheck, Inbox } from "lucide-react"
import { useTenant } from "@/app/[tenant]/tenant-provider"
import { useNotifications } from "@/lib/notifications-context"
import { can } from "@/lib/permissions"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import type { Notification, NotificationsInboxResponse } from "@/components/platform/notifications/types"

const FLYOUT_LIMIT = 20

function relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime()
    const m = Math.floor(diff / 60000)
    if (m < 1) return "just now"
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
}

function dayBucket(iso: string): string {
    const d = new Date(iso)
    const now = new Date()
    const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
    if (diffDays <= 0) return "Today"
    if (diffDays === 1) return "Yesterday"
    return "Earlier"
}

// Notifications used to be a full sidebar row that navigated to its own page —
// routing away destroyed whatever the user was doing (an open chat, a Drive
// selection). This is a glance-and-dismiss flyout instead, anchored to the
// sidebar's utility cluster next to the account menu. The dedicated
// /notifications page still exists as the paginated archive ("View all"
// below, plus the deep-link target for emails/pushes) — this panel just
// shows the most recent items inline.
export function NotificationsBell({ collapsed, compact }: { collapsed?: boolean; compact?: boolean }) {
    const [isOpen, setIsOpen] = React.useState(false)
    const { tenantSlug, permissions = [] } = useTenant()
    const router = useRouter()
    const queryClient = useQueryClient()
    const { unreadCount, markAllRead: clearBadge, setUnreadCount } = useNotifications()
    const canUpdate = can(permissions, "notifications", "update")

    const queryKey = ["notifications-inbox-flyout", tenantSlug] as const

    const { data, isLoading } = useQuery<NotificationsInboxResponse>({
        queryKey,
        queryFn: () =>
            api.get<NotificationsInboxResponse>(
                `/api/v1/notifications/inbox?page=1&pageSize=${FLYOUT_LIMIT}`,
            ),
        enabled: isOpen,
    })

    const markReadMutation = useMutation({
        mutationFn: (id: string) => api.patch(`/api/v1/notifications/inbox/${id}/read`),
        onMutate: async (id: string) => {
            await queryClient.cancelQueries({ queryKey })
            queryClient.setQueryData<NotificationsInboxResponse>(queryKey, (old) => {
                if (!old) return old
                return {
                    ...old,
                    items: old.items.map((n) => (n.id === id ? { ...n, read: true, readAt: new Date().toISOString() } : n)),
                }
            })
            setUnreadCount((prev) => Math.max(0, prev - 1))
        },
    })

    const markAllMutation = useMutation({
        mutationFn: () => api.post(`/api/v1/notifications/inbox/read-all`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey })
            clearBadge()
        },
    })

    const handleRowClick = (n: Notification) => {
        if (!n.read && canUpdate) markReadMutation.mutate(n.id)
        if (n.metadata?.taskId) {
            setIsOpen(false)
            router.push(`/${tenantSlug}/dashboard/board/${n.metadata.taskId}`)
        }
    }

    const items = data?.items ?? []
    let lastBucket = ""

    return (
        <Popover open={isOpen} onOpenChange={setIsOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    data-testid="notifications-bell"
                    aria-label="Notifications"
                    className={cn(
                        "flex items-center rounded-lg transition-all hover:bg-accent/50 shrink-0",
                        compact ? "p-1.5" : cn("gap-3 w-full text-left", collapsed ? "justify-center px-2 py-2" : "px-2.5 py-2 mb-2")
                    )}
                >
                    <span className="relative shrink-0">
                        <Bell className="h-4 w-4 text-muted-foreground" />
                        {unreadCount > 0 && (
                            <Badge className="absolute -top-1.5 -right-1.5 h-4 min-w-4 px-1 text-[9px] font-bold bg-primary text-primary-foreground border-transparent">
                                {unreadCount > 99 ? "99+" : unreadCount}
                            </Badge>
                        )}
                    </span>
                    {!collapsed && !compact && (
                        <span className="text-[13px] text-muted-foreground">Notifications</span>
                    )}
                </button>
            </PopoverTrigger>

            <PopoverContent side={collapsed ? "right" : "top"} align="start" className="w-80 p-0 overflow-hidden">
                <div className="flex items-center justify-between px-3.5 py-3 border-b border-border/60">
                    <p className="text-[13px] font-semibold text-foreground">Notifications</p>
                    {unreadCount > 0 && canUpdate && (
                        <button
                            type="button"
                            onClick={() => markAllMutation.mutate()}
                            disabled={markAllMutation.isPending}
                            className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                        >
                            <CheckCheck className="h-3 w-3" />
                            Mark all read
                        </button>
                    )}
                </div>

                <div className="max-h-96 overflow-y-auto custom-scrollbar">
                    {isLoading && (
                        <div className="px-3.5 py-8 text-center text-[12px] text-muted-foreground">Loading…</div>
                    )}

                    {!isLoading && items.length === 0 && (
                        <div className="flex flex-col items-center gap-2 px-3.5 py-10 text-muted-foreground">
                            <Inbox className="h-6 w-6 opacity-40" />
                            <p className="text-[12px]">You&apos;re all caught up.</p>
                        </div>
                    )}

                    {!isLoading && items.map((n) => {
                        const bucket = dayBucket(n.createdAt)
                        const showHeader = bucket !== lastBucket
                        lastBucket = bucket
                        return (
                            <React.Fragment key={n.id}>
                                {showHeader && (
                                    <p className="px-3.5 pt-2.5 pb-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">
                                        {bucket}
                                    </p>
                                )}
                                <button
                                    type="button"
                                    onClick={() => handleRowClick(n)}
                                    className={cn(
                                        "flex w-full flex-col gap-0.5 px-3.5 py-2 text-left transition-colors hover:bg-accent/50",
                                        !n.read && "bg-primary/5"
                                    )}
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <p className={cn("text-[12.5px] leading-snug", n.read ? "font-medium text-muted-foreground" : "font-semibold text-foreground")}>
                                            {n.title}
                                        </p>
                                        <span className="shrink-0 text-[10px] text-muted-foreground/70 whitespace-nowrap">
                                            {relativeTime(n.createdAt)}
                                        </span>
                                    </div>
                                    <p className="text-[11.5px] text-muted-foreground line-clamp-2 leading-relaxed">
                                        {n.body}
                                    </p>
                                </button>
                            </React.Fragment>
                        )
                    })}
                </div>

                <Link
                    href={`/${tenantSlug}/dashboard/notifications`}
                    onClick={() => setIsOpen(false)}
                    className="block px-3.5 py-2.5 text-center text-[12px] font-medium text-foreground border-t border-border/60 hover:bg-accent/50 transition-colors"
                >
                    View all
                </Link>
            </PopoverContent>
        </Popover>
    )
}
