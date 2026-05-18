"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Notification } from "@/components/platform/notifications/types";
import { relativeTime } from "./_helpers";

interface NotificationRowProps {
    notification: Notification;
    canUpdate: boolean;
    isApproving: boolean;
    onClick: (n: Notification) => void;
    onApprove: (n: Notification) => void;
}

export function NotificationRow({ notification: n, canUpdate, isApproving, onClick, onApprove }: NotificationRowProps) {
    const isApprovalTask =
        n.messageType === "task.awaiting_approval" && typeof n.metadata?.taskId === "string";
    const isClickable = (canUpdate && !n.read) || !!n.metadata?.taskId;

    return (
        <div
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

            {isApprovalTask && (
                <div className="mt-2.5 flex justify-end">
                    <Button
                        size="sm"
                        onClick={(e) => {
                            e.stopPropagation();
                            onApprove(n);
                        }}
                        disabled={isApproving}
                    >
                        Approve
                    </Button>
                </div>
            )}

            {!isApprovalTask && !n.read && canUpdate && (
                <div className="absolute right-4 bottom-3 opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-[10px] uppercase font-bold tracking-wider text-primary">
                        Click to mark read
                    </span>
                </div>
            )}
        </div>
    );
}
