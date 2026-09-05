"use client";

import { Badge } from "@/components/ui/badge";
import type { Notification } from "@/components/platform/notifications/types";
import { NotificationIcon } from "@/components/platform/notifications/notificationVisuals";
import { relativeTime } from "./_helpers";

interface NotificationRowProps {
    notification: Notification;
    canUpdate: boolean;
    onClick: (n: Notification) => void;
}

// `task.awaiting_approval` notifications used to render their own "Approve"
// button here, wired directly to PUT /tasks/:taskId/plan/approve with no
// cost estimate and no balance check — a bypass of the gated
// `TaskExecutionCost` / `ApproveCost` card on the task detail page, which is
// the only place a plan approval should be committed (see
// docs/superpowers/specs/2026-08-28-credit-system-design.md). This row now
// behaves like every other notification type: clicking it navigates to the
// task detail page, where the gated card lives.
export function NotificationRow({ notification: n, canUpdate, onClick }: NotificationRowProps) {
    const isClickable = (canUpdate && !n.read) || !!n.metadata?.taskId;

    return (
        <div
            data-testid="notification-row"
            role="button"
            tabIndex={0}
            onClick={() => onClick(n)}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onClick(n);
            }}
            className={[
                "rounded-lg px-4 py-3.5 transition-colors group relative",
                isClickable ? "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring" : "",
                n.read
                    ? "bg-transparent hover:bg-muted/40"
                    : "border border-primary/20 bg-primary/5 hover:bg-primary/10",
            ].join(" ")}
        >
            <div className="flex items-start justify-between gap-3">
                <NotificationIcon messageType={n.messageType} className="mt-0.5" />
                <div className="min-w-0 flex-1 space-y-1">
                    <p
                        className={[
                            "text-sm leading-snug",
                            n.read ? "font-medium text-muted-foreground" : "font-bold text-primary",
                        ].join(" ")}
                    >
                        {n.title}
                    </p>
                    <p
                        className={[
                            "text-sm line-clamp-2 leading-relaxed",
                            n.read ? "text-muted-foreground/70" : "text-foreground/90",
                        ].join(" ")}
                    >
                        {n.body}
                    </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5">
                    <span className="text-[11px] text-muted-foreground whitespace-nowrap font-medium">
                        {relativeTime(n.createdAt)}
                    </span>
                    <Badge
                        variant="secondary"
                        className="text-[9px] uppercase font-bold tracking-wider px-1.5 py-0"
                    >
                        {n.messageType}
                    </Badge>
                </div>
            </div>

            {!n.read && canUpdate && (
                <div className="absolute right-4 bottom-3 opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-[10px] uppercase font-bold tracking-wider text-primary">
                        Click to mark read
                    </span>
                </div>
            )}
        </div>
    );
}
