"use client";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface LeaveWorkspaceModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    workspaceName: string;
    tenantId: string;
}

export function LeaveWorkspaceModal({ open, onOpenChange, workspaceName, tenantId }: LeaveWorkspaceModalProps) {
    const leaveMutation = useMutation({
        mutationFn: () => api.del(`/api/v1/workspaces/${tenantId}/members/me`),
        onSuccess: async () => {
            toast.success("You have left the workspace");
            try {
                const tenantsRes = await api.get<{
                    tenants: { tenantId: string; slug: string; name: string }[];
                }>("/api/v1/auth/tenants");

                const remaining = (tenantsRes.tenants ?? []).filter((t) => t.tenantId !== tenantId);

                if (remaining.length > 0) {
                    const next = remaining[0];
                    await fetch("/api/auth/refresh", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ tenantId: next.tenantId }),
                    });
                    window.location.href = `/${next.slug}/dashboard`;
                    return;
                }
            } catch {
                // no workspaces reachable, clear session
            }

            await fetch("/api/auth/session", { method: "DELETE" });
            window.location.href = "/auth/login";
        },
        onError: (error: unknown) => {
            if (error instanceof ApiError) {
                const code = error.data?.code;
                if (code === "SOLE_OWNER_LEAVE_BLOCKED") {
                    toast.error("You are the sole owner. Transfer ownership or delete the workspace.");
                    onOpenChange(false);
                    return;
                }
            }
            toast.error("Failed to leave workspace. Please try again.");
        },
    });

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Leave Workspace</DialogTitle>
                    <DialogDescription>
                        You will lose access to{" "}
                        <span className="font-semibold text-foreground">{workspaceName}</span> and
                        will need to be re-invited to rejoin.
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={leaveMutation.isPending}>
                        Cancel
                    </Button>
                    <Button variant="destructive" onClick={() => leaveMutation.mutate()} disabled={leaveMutation.isPending}>
                        {leaveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Leave workspace
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
