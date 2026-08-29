"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Inbox, AlertCircle, CheckCheck } from "lucide-react";
import { api } from "@/lib/api";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { PermissionGate } from "@/components/platform/PermissionGate";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useNotifications } from "@/lib/notifications-context";
import { can } from "@/lib/permissions";
import type {
    Notification,
    NotificationsInboxResponse,
} from "@/components/platform/notifications/types";

import { PaginationControls } from "@/components/ui/pagination-controls";
import { NotificationRow } from "./NotificationRow";
import { PAGE_SIZE } from "./_helpers";

export default function NotificationsPage() {
    const params = useParams();
    const tenantSlug = params.tenant as string;
    const router = useRouter();
    const { permissions = [] } = useTenant();

    const { markAllRead: clearSidebarBadge, setUnreadCount } = useNotifications();
    const canUpdate = can(permissions, "notifications", "update");

    const queryClient = useQueryClient();
    const [page, setPage] = React.useState(1);

    const queryKey = ["notifications-inbox", tenantSlug, page] as const;

    React.useEffect(() => {
        clearSidebarBadge();
    }, [clearSidebarBadge]);

    const { data, isLoading, isError, error } = useQuery<NotificationsInboxResponse>({
        queryKey,
        queryFn: () =>
            api.get<NotificationsInboxResponse>(
                `/api/v1/notifications/inbox?page=${page}&pageSize=${PAGE_SIZE}`,
            ),
    });

    const markReadMutation = useMutation({
        mutationFn: (id: string) => api.patch(`/api/v1/notifications/inbox/${id}/read`),
        onMutate: async (id: string) => {
            await queryClient.cancelQueries({ queryKey });
            queryClient.setQueryData<NotificationsInboxResponse>(queryKey, (old) => {
                if (!old) return old;
                return {
                    ...old,
                    unreadCount: Math.max(0, old.unreadCount - 1),
                    items: old.items.map((n) =>
                        n.id === id
                            ? { ...n, read: true, readAt: new Date().toISOString() }
                            : n,
                    ),
                };
            });
            setUnreadCount((prev) => Math.max(0, prev - 1));
        },
    });

    const markAllMutation = useMutation({
        mutationFn: () => api.post(`/api/v1/notifications/inbox/read-all`),
        onSuccess: () => {
            setPage(1);
            queryClient.invalidateQueries({ queryKey: ["notifications-inbox", tenantSlug, page] });
            clearSidebarBadge();
        },
    });

    const notifications = data?.items ?? [];
    const totalPages = Math.ceil((data?.total ?? 0) / (data?.limit ?? PAGE_SIZE)) || 1;
    const unreadCount = data?.unreadCount ?? 0;

    const handleRowClick = (n: Notification) => {
        if (!n.read && canUpdate) markReadMutation.mutate(n.id);
        if (n.metadata?.taskId) {
            router.push(`/${tenantSlug}/dashboard/board/${n.metadata.taskId}`);
        }
    };

    return (
        <PermissionGate resource="notifications" action="read">
            <div className="space-y-6">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight">Notifications</h1>
                        <p className="text-muted-foreground mt-1">
                            Stay up to date with activity across your workspace.
                        </p>
                    </div>

                    {unreadCount > 0 && !isLoading && !isError && canUpdate && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5 shrink-0"
                            onClick={() => markAllMutation.mutate()}
                            disabled={markAllMutation.isPending}
                        >
                            <CheckCheck className="h-4 w-4" />
                            Mark all as read
                        </Button>
                    )}
                </div>

                {isLoading && (
                    <div className="space-y-2">
                        {Array.from({ length: 5 }).map((_, i) => (
                            <div key={i} className="rounded-lg border border-border p-4 space-y-2">
                                <Skeleton className="h-4 w-2/5" />
                                <Skeleton className="h-3 w-4/5" />
                            </div>
                        ))}
                    </div>
                )}

                {isError && (
                    <Alert variant="destructive">
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle>Error</AlertTitle>
                        <AlertDescription>
                            {error instanceof Error ? error.message : "Failed to load notifications."}
                        </AlertDescription>
                    </Alert>
                )}

                {!isLoading && !isError && notifications.length === 0 && (
                    <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
                        <Inbox className="h-10 w-10 opacity-40" />
                        <p className="text-base font-medium">You&apos;re all caught up.</p>
                    </div>
                )}

                {!isLoading && !isError && notifications.length > 0 && (
                    <div className="flex flex-col gap-1">
                        {notifications.map((n) => (
                            <NotificationRow
                                key={n.id}
                                notification={n}
                                canUpdate={canUpdate}
                                onClick={handleRowClick}
                            />
                        ))}
                    </div>
                )}

                {!isLoading && !isError && notifications.length > 0 && (
                    <PaginationControls
                        page={page}
                        totalPages={totalPages}
                        onPrev={() => setPage((p) => Math.max(1, p - 1))}
                        onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
                    />
                )}
            </div>
        </PermissionGate>
    );
}
